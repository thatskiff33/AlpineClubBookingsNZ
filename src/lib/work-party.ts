/**
 * Work party (working bee) events.
 *
 * Each event owns an internal auto-applied PromoCode (type PERCENTAGE) so
 * redemption tracking, pricing, Xero, the $0 confirmation path, and bump
 * cleanup all reuse the existing promo machinery. Internal promo codes are
 * hidden from every promo listing and rejected at manual code entry; they
 * only enter a booking through an explicit work party event selection.
 *
 * Night-window semantics: the discount applies to guest nights from
 * startDate to endDate, both inclusive (matching Season night semantics).
 * Booking nights remain half-open (checkIn inclusive, checkOut exclusive).
 */
import { randomInt } from "crypto";
import { Prisma, PromoCodeType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  addDaysDateOnly,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";

type WorkPartyDbClient = typeof prisma | Prisma.TransactionClient;

export interface WorkPartyNightWindow {
  startDate: Date;
  endDate: Date;
}

export const WORK_PARTY_PROMO_CODE_PREFIX = "WORKPARTY-";

// Unambiguous uppercase charset (no I/L/O/0/1) for generated internal codes.
const CODE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_SUFFIX_LENGTH = 8;

export function generateWorkPartyPromoCode(): string {
  let suffix = "";
  for (let i = 0; i < CODE_SUFFIX_LENGTH; i++) {
    // randomInt uses rejection sampling so every character is chosen with
    // equal probability (a `randomBytes(...)[i] % charset.length` approach
    // would be subtly biased for charset lengths that aren't a power of two).
    suffix += CODE_CHARSET[randomInt(0, CODE_CHARSET.length)];
  }
  return `${WORK_PARTY_PROMO_CODE_PREFIX}${suffix}`;
}

/**
 * True when at least one booking night (checkIn..checkOut-1) falls inside
 * the event window (startDate..endDate inclusive). All inputs must be
 * date-only values (UTC midnight), the booking-date convention.
 */
export function workPartyWindowOverlapsStay(
  window: WorkPartyNightWindow,
  checkIn: Date,
  checkOut: Date
): boolean {
  const checkInKey = formatDateOnly(checkIn);
  const lastNightKey = formatDateOnly(addDaysDateOnly(checkOut, -1));
  if (checkInKey > lastNightKey) return false;
  return (
    formatDateOnly(window.startDate) <= lastNightKey &&
    formatDateOnly(window.endDate) >= checkInKey
  );
}

/**
 * Restrict a guest's positional per-night rates to the nights inside the
 * event window. `firstNight` is the date of perNightRates[0] (the guest's
 * effective stay start used when the rates were priced). Out-of-window
 * nights are dropped so they contribute nothing to the discount while the
 * booking total still charges them in full.
 */
export function restrictPerNightRatesToWindow(
  perNightRates: number[],
  firstNight: Date,
  window: WorkPartyNightWindow
): number[] {
  const startKey = formatDateOnly(window.startDate);
  const endKey = formatDateOnly(window.endDate);
  return perNightRates.filter((_, index) => {
    const nightKey = formatDateOnly(addDaysDateOnly(firstNight, index));
    return nightKey >= startKey && nightKey <= endKey;
  });
}

/**
 * Look up the night window for an internal work party promo. Returns null
 * when the promo has no linked event (non-work-party internal promos, or
 * an event deleted without redemptions).
 */
export async function getWorkPartyNightWindowForPromo(
  db: WorkPartyDbClient,
  promoCodeId: string
): Promise<WorkPartyNightWindow | null> {
  const event = await db.workPartyEvent.findUnique({
    where: { promoCodeId },
    select: { startDate: true, endDate: true },
  });
  return event ? { startDate: event.startDate, endDate: event.endDate } : null;
}

/**
 * Active events whose window overlaps the requested stay, for the booking
 * form's "I am attending a working bee" picker.
 */
export async function findActiveWorkPartyEventsForRange(
  checkIn: Date,
  checkOut: Date,
  db: WorkPartyDbClient = prisma
) {
  return db.workPartyEvent.findMany({
    where: {
      active: true,
      // startDate < checkOut means the event starts on or before the last
      // booking night; endDate >= checkIn means it ends on or after the
      // first night.
      startDate: { lt: checkOut },
      endDate: { gte: checkIn },
      promoCode: { active: true, archivedAt: null },
    },
    select: {
      id: true,
      name: true,
      description: true,
      startDate: true,
      endDate: true,
      discountPercent: true,
    },
    orderBy: { startDate: "asc" },
  });
}

export type WorkPartyPromoResolution =
  | { ok: true; promoCodeStr: string; eventName: string }
  | { ok: false; error: string };

/**
 * Resolve a selected work party event to its internal promo code for the
 * booking-create paths. Validates the event is active and overlaps the
 * stay; the caller passes the returned code through the normal promo
 * resolution path (with internal codes allowed).
 */
export async function resolveWorkPartyEventPromoForBooking(
  db: WorkPartyDbClient,
  workPartyEventId: string,
  checkIn: Date,
  checkOut: Date
): Promise<WorkPartyPromoResolution> {
  const event = await db.workPartyEvent.findUnique({
    where: { id: workPartyEventId },
    select: {
      name: true,
      active: true,
      startDate: true,
      endDate: true,
      promoCode: { select: { code: true, active: true, archivedAt: true } },
    },
  });

  if (!event) {
    return { ok: false, error: "Working bee event not found" };
  }
  if (!event.active || !event.promoCode.active || event.promoCode.archivedAt) {
    return { ok: false, error: "This working bee event is no longer active" };
  }
  if (!workPartyWindowOverlapsStay(event, checkIn, checkOut)) {
    return {
      ok: false,
      error: "This working bee event does not overlap your booking dates",
    };
  }

  return { ok: true, promoCodeStr: event.promoCode.code, eventName: event.name };
}

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

// Shared by the admin work-parties create and update routes.
export const workPartyEventSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional().nullable(),
    startDate: dateOnlyString.transform(parseDateOnly),
    endDate: dateOnlyString.transform(parseDateOnly),
    discountPercent: z.number().int().min(1).max(100).default(100),
    active: z.boolean().default(true),
  })
  .strict();

export function workPartyEventDatesError(data: {
  startDate: Date;
  endDate: Date;
}): string | null {
  if (formatDateOnly(data.endDate) < formatDateOnly(data.startDate)) {
    return "End date must be on or after the start date";
  }
  return null;
}

export interface WorkPartyEventInput {
  name: string;
  description?: string | null;
  startDate: Date;
  endDate: Date;
  discountPercent: number;
  active: boolean;
}

function internalPromoDataForEvent(input: WorkPartyEventInput) {
  return {
    description: `Working bee: ${input.name}`,
    type: PromoCodeType.PERCENTAGE,
    percentOff: input.discountPercent,
    membersOnly: true,
    active: input.active,
  };
}

const CODE_GENERATION_ATTEMPTS = 5;

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * Create a work party event together with its internal promo. Retries code
 * generation on the (unlikely) unique-code collision.
 */
export async function createWorkPartyEventWithPromo(input: WorkPartyEventInput) {
  for (let attempt = 1; attempt <= CODE_GENERATION_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const promoCode = await tx.promoCode.create({
          data: {
            code: generateWorkPartyPromoCode(),
            internal: true,
            ...internalPromoDataForEvent(input),
          },
        });
        return tx.workPartyEvent.create({
          data: {
            name: input.name,
            description: input.description ?? null,
            startDate: input.startDate,
            endDate: input.endDate,
            discountPercent: input.discountPercent,
            active: input.active,
            promoCodeId: promoCode.id,
          },
          include: { promoCode: { select: { id: true, code: true } } },
        });
      });
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < CODE_GENERATION_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Failed to generate a unique work party promo code");
}

/**
 * Update an event and keep its internal promo in sync. Deactivating stops
 * new applications only — existing redemptions and bookings are never
 * touched.
 */
export async function updateWorkPartyEventAndPromo(
  id: string,
  input: WorkPartyEventInput
) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.workPartyEvent.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        discountPercent: input.discountPercent,
        active: input.active,
      },
    });
    await tx.promoCode.update({
      where: { id: event.promoCodeId },
      data: internalPromoDataForEvent(input),
    });
    return event;
  });
}
