const BOOKING_DELETED_VISIBILITY_VALUES = [
  "hide",
  "include",
  "only",
] as const;

export type BookingDeletedVisibility =
  (typeof BOOKING_DELETED_VISIBILITY_VALUES)[number];

export function parseBookingDeletedVisibility(
  value: string | null | undefined
): BookingDeletedVisibility {
  return BOOKING_DELETED_VISIBILITY_VALUES.includes(
    value as BookingDeletedVisibility
  )
    ? (value as BookingDeletedVisibility)
    : "hide";
}

/**
 * #3745 (INV-SSOT): the one definition of each view - whether it shows a live
 * booking and whether it shows a soft-deleted one. The query filter and the
 * row test below are both read off this table, so a database read and an
 * in-memory scope (Net Collected's, `payment-net-collected.ts`) cannot drift.
 */
const BOOKING_DELETED_VISIBILITY_SHOWS: Record<
  BookingDeletedVisibility,
  { live: boolean; deleted: boolean }
> = {
  hide: { live: true, deleted: false },
  include: { live: true, deleted: true },
  only: { live: false, deleted: true },
};

export function buildBookingDeletedWhere(
  visibility: BookingDeletedVisibility
): { deletedAt?: null | { not: null } } {
  const shows = BOOKING_DELETED_VISIBILITY_SHOWS[visibility];
  if (shows.live && shows.deleted) {
    return {};
  }

  return {
    deletedAt: shows.live ? null : { not: null },
  };
}

/** The row-level twin of `buildBookingDeletedWhere`, for rows already loaded. */
export function isBookingShownIn(
  visibility: BookingDeletedVisibility,
  booking: { deletedAt: Date | null }
): boolean {
  const shows = BOOKING_DELETED_VISIBILITY_SHOWS[visibility];
  return booking.deletedAt === null ? shows.live : shows.deleted;
}
