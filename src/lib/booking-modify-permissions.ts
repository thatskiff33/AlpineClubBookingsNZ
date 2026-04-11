const MEMBER_MODIFIABLE_BOOKING_STATUSES = new Set([
  "PENDING",
  "CONFIRMED",
  "PAID",
]);

const ADMIN_EXTRA_MODIFIABLE_BOOKING_STATUSES = new Set([
  "DRAFT",
  "WAITLISTED",
  "WAITLIST_OFFERED",
  "BUMPED",
]);

export function canModifyBookingStatus(status: string, role: string): boolean {
  return (
    MEMBER_MODIFIABLE_BOOKING_STATUSES.has(status) ||
    (role === "ADMIN" && ADMIN_EXTRA_MODIFIABLE_BOOKING_STATUSES.has(status))
  );
}

export function usesActiveBookingLifecycle(status: string): boolean {
  return MEMBER_MODIFIABLE_BOOKING_STATUSES.has(status);
}
