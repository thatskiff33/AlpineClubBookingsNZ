export const ADMIN_NOTIFICATION_PREFERENCE_META = {
  adminNewBooking: {
    label: "New bookings",
    description: "Alerts when a new booking is created or confirmed.",
  },
  adminPaymentFailure: {
    label: "Payment failures",
    description: "Alerts when a booking payment fails.",
  },
  adminPendingDeadline: {
    label: "Pending deadlines",
    description: "Digest alerts for bookings approaching their pending deadline.",
  },
  adminBookingBumped: {
    label: "Bookings bumped",
    description: "Alerts when a pending booking is bumped by another booking.",
  },
  adminXeroSyncError: {
    label: "Xero sync errors",
    description: "Alerts when Xero contact or invoice sync fails.",
  },
  adminCapacityWarning: {
    label: "Capacity warnings",
    description: "Alerts when occupancy is nearing full capacity.",
  },
  adminDailyDigest: {
    label: "Daily digest",
    description: "A daily summary of admin alerts from the previous 24 hours.",
  },
  adminWaitlistOffer: {
    label: "Waitlist offers",
    description: "Alerts when a waitlist spot is offered to a member.",
  },
} as const;

export type AdminNotificationPreferenceKey =
  keyof typeof ADMIN_NOTIFICATION_PREFERENCE_META;

export type AdminNotificationPreferences = Record<
  AdminNotificationPreferenceKey,
  boolean
>;

export const ADMIN_NOTIFICATION_PREFERENCE_KEYS = Object.keys(
  ADMIN_NOTIFICATION_PREFERENCE_META
) as AdminNotificationPreferenceKey[];

export const ADMIN_NOTIFICATION_PREFERENCE_SELECT = {
  adminNewBooking: true,
  adminPaymentFailure: true,
  adminPendingDeadline: true,
  adminBookingBumped: true,
  adminXeroSyncError: true,
  adminCapacityWarning: true,
  adminDailyDigest: true,
  adminWaitlistOffer: true,
} as const;

export function resolveAdminNotificationPreferences(
  preferences?: Partial<AdminNotificationPreferences> | null
): AdminNotificationPreferences {
  return {
    adminNewBooking: preferences?.adminNewBooking ?? true,
    adminPaymentFailure: preferences?.adminPaymentFailure ?? true,
    adminPendingDeadline: preferences?.adminPendingDeadline ?? true,
    adminBookingBumped: preferences?.adminBookingBumped ?? true,
    adminXeroSyncError: preferences?.adminXeroSyncError ?? true,
    adminCapacityWarning: preferences?.adminCapacityWarning ?? true,
    adminDailyDigest: preferences?.adminDailyDigest ?? true,
    adminWaitlistOffer: preferences?.adminWaitlistOffer ?? true,
  };
}
