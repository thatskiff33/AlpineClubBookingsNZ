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
import logger from "@/lib/logger";
import {
  describeUniqueConstraintTarget,
  isPrismaUniqueConstraintError,
} from "@/lib/prisma-errors";
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

// test seam
export const WORK_PARTY_PROMO_CODE_PREFIX = "WORKPARTY-";

// Unambiguous uppercase charset (no I/L/O/0/1) for generated internal codes.
const CODE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_SUFFIX_LENGTH = 8;

// test seam
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
 * Restrict a guest's per-night rates to the nights inside the event window.
 * Out-of-window nights are dropped so they contribute nothing to the discount
 * while the booking total still charges them in full.
 *
 * `nightDates` (issue #713) are the actual dates of each rate, parallel to
 * perNightRates. When provided they are used directly, which is correct for
 * non-contiguous stays. When omitted, dates are derived positionally from
 * `firstNight` (the date of perNightRates[0]) assuming a contiguous run — the
 * pre-#713 behaviour, preserved for any caller that does not supply dates.
 */
export function restrictPerNightRatesToWindow(
  perNightRates: number[],
  firstNight: Date,
  window: WorkPartyNightWindow,
  nightDates?: ReadonlyArray<Date> | null
): number[] {
  return inWindowNightIndexes(perNightRates.length, firstNight, window, nightDates).map(
    (index) => perNightRates[index]
  );
}

/**
 * The positions, among `nightCount` nights, that fall inside the event window
 * (#3276) — the ONE statement of the window rule, which
 * `restrictPerNightRatesToWindow` narrows to rates. `promo.ts` needs the
 * positions themselves so it can keep a guest's `nightDates` parallel to the
 * rates it filters: an adjustment row is attributed to a night by DATE, and a
 * rate vector filtered without its dates would attribute the discount to the
 * wrong nights on any stay the window only partly covers.
 */
export function inWindowNightIndexes(
  nightCount: number,
  firstNight: Date,
  window: WorkPartyNightWindow,
  nightDates?: ReadonlyArray<Date> | null
): number[] {
  const startKey = formatDateOnly(window.startDate);
  const endKey = formatDateOnly(window.endDate);
  const kept: number[] = [];
  for (let index = 0; index < nightCount; index += 1) {
    const nightDate =
      nightDates && nightDates[index]
        ? nightDates[index]
        : addDaysDateOnly(firstNight, index);
    const nightKey = formatDateOnly(nightDate);
    if (nightKey >= startKey && nightKey <= endKey) kept.push(index);
  }
  return kept;
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
  db: WorkPartyDbClient = prisma,
  // Lodge the member is booking (lodge-scoping contract): filters out
  // events bound to a different lodge. Omitted keeps the historical
  // behaviour of listing every active event; lodge-less events are
  // club-wide and always listed.
  lodgeId?: string | null
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
      ...(lodgeId ? { OR: [{ lodgeId: null }, { lodgeId }] } : {}),
    },
    select: {
      id: true,
      name: true,
      description: true,
      startDate: true,
      endDate: true,
      discountPercent: true,
      lodgeId: true,
      lodge: { select: { name: true } },
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
  checkOut: Date,
  // Lodge the booking is being created at. An event bound to a lodge can
  // only discount stays at that lodge; lodge-less events stay club-wide.
  bookingLodgeId?: string | null
): Promise<WorkPartyPromoResolution> {
  const event = await db.workPartyEvent.findUnique({
    where: { id: workPartyEventId },
    select: {
      name: true,
      active: true,
      startDate: true,
      endDate: true,
      lodgeId: true,
      lodge: { select: { name: true } },
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
  if (event.lodgeId && bookingLodgeId && event.lodgeId !== bookingLodgeId) {
    return {
      ok: false,
      error: `This working bee is held at ${event.lodge?.name ?? "another lodge"} — book that lodge to attend it`,
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
    // Lodge the working bee is held at; null/omitted = club-wide event.
    lodgeId: z.string().min(1).optional().nullable(),
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
  lodgeId?: string | null;
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

/**
 * The names a `PromoCode.code` collision can arrive under: the COLUMN, which is
 * what `@prisma/adapter-pg` reports, and the INDEX, which is all that survives
 * if Postgres ever withholds the `Key (…)` detail.
 */
const PROMO_CODE_CONSTRAINT_NAMES = new Set(["code", "promocode_code_key"]);

/**
 * Was this P2002 the generated promo `code` colliding — the one thing the retry
 * below exists for — rather than the event's own `promoCodeId`? (#2455)
 *
 * This used to be a bare "is it a P2002?", so ANY unique violation inside the
 * transaction spent the whole five-attempt budget regenerating a code that was
 * never the problem. See `describeUniqueConstraintTarget` for what the driver
 * adapter really populates (measured, #2412): the colliding COLUMNS, quoted as
 * Postgres quoted them, which the helper lowercases and unquotes.
 *
 * The comparison is deliberately WORD-level rather than a substring test:
 * `WorkPartyEvent.promoCodeId` normalises to `promocodeid`, which contains
 * "code", so `target.includes("code")` would call the sibling constraint a code
 * collision and retry it four more times for nothing.
 *
 * A P2002 that names NOTHING gets the benefit of the doubt and spends a retry,
 * on this transaction's own arithmetic rather than any precedent: the only
 * unique-bearing writes it makes are the generated `PromoCode.code` and
 * `WorkPartyEvent.promoCodeId`, and that second one is the cuid minted by the
 * statement immediately above, so it cannot collide with a row that already
 * exists. An unnamed collision here is therefore almost certainly the code, and
 * re-rolling it is exactly the right response. (The other two sites narrowed in
 * #2455 keep the unnamed case for the same reason — each is the only collision
 * its transaction can produce.) The join-code retry in `group-booking.ts`
 * declines the same case, but its transaction ALSO writes
 * `GroupBooking.organiserBookingId` from caller input, which genuinely can
 * collide, so an unnamed P2002 there is ambiguous in a way this one is not.
 */
function isGeneratedPromoCodeCollision(err: unknown): boolean {
  if (!isPrismaUniqueConstraintError(err)) {
    return false;
  }
  const target = describeUniqueConstraintTarget(err);
  if (target === null) {
    logger.warn(
      { err },
      "Work party promo code collision carried no constraint name; retrying as a code collision"
    );
    return true;
  }
  return target.split(" ").some((name) => PROMO_CODE_CONSTRAINT_NAMES.has(name));
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
            lodgeId: input.lodgeId ?? null,
            promoCodeId: promoCode.id,
          },
          include: { promoCode: { select: { id: true, code: true } } },
        });
      });
    } catch (err) {
      if (isGeneratedPromoCodeCollision(err)) {
        if (attempt < CODE_GENERATION_ATTEMPTS) {
          continue;
        }
        // Unreachable in practice at 31^8 codes, so exhausting the budget on
        // genuine collisions means something else is wrong. Logged with the
        // constraint it read, because the raw P2002 that leaves here loses its
        // `meta` to the pino `err` serializer.
        logger.error(
          {
            attempts: CODE_GENERATION_ATTEMPTS,
            constraint: describeUniqueConstraintTarget(err),
          },
          "Work party promo code generation exhausted its attempts"
        );
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
        lodgeId: input.lodgeId ?? null,
      },
    });
    await tx.promoCode.update({
      where: { id: event.promoCodeId },
      data: internalPromoDataForEvent(input),
    });
    return event;
  });
}
