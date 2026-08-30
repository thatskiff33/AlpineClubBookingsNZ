import {
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  type AdminAccessRequirement,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";

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
  adminFamilyGroupRequest: {
    label: "Member requests",
    description:
      "Alerts when a member request needs admin review, including membership applications, family groups, cancellation, archive, and self-service account-deletion requests.",
  },
  adminBookingChangeRequest: {
    label: "Booking change requests",
    description:
      "Alerts when a member submits a booking change request that needs admin review.",
  },
  adminRefundRequest: {
    label: "Refund requests",
    description: "Alerts when a member submits a refund appeal.",
  },
  adminIssueReport: {
    label: "Reported issues",
    description: "Alerts when a logged-in user reports a site issue for admin follow-up.",
  },
  adminBookingRequest: {
    label: "Public booking requests",
    description:
      "Alerts when a public booking request is verified and ready for pricing, or when a request booking's hold expires unpaid.",
  },
  adminBookingReviewRequired: {
    label: "Booking review required",
    description:
      "Alerts when a booking needs admin review before it can check in, such as a paid booking left with only under-18 guests. Kept separate so muting routine new-booking alerts does not silence this review alert.",
  },
  adminMemberDeleteRequest: {
    label: "Member delete requests",
    description:
      "Alerts when an admin requests a permanent member-record hard delete that a different admin must approve. Kept separate from the shared member-requests category so muting family-group and application alerts does not silence delete-request review alerts.",
  },
  adminMaintenanceReport: {
    label: "Maintenance reports",
    description:
      "Alerts when somebody reports a physical fault at a lodge, from the members' portal or from a QR code in the lodge.",
  },
} as const;

export type AdminNotificationPreferenceKey =
  keyof typeof ADMIN_NOTIFICATION_PREFERENCE_META;

/**
 * The admin permission each alert category belongs to (#2548).
 *
 * Admin alerts used to be resolved from the legacy scalar `Member.role`
 * (`role: "ADMIN"`), so only Full Admins ever received one: a Booking Officer,
 * a Treasurer, a Membership Officer and every definition-backed CUSTOM role all
 * collapse to legacy `USER` and silently got nothing — including the
 * booking-change-request and booking-policy-exception alerts they are the very
 * people expected to action. The audience is now resolved from the access-role
 * permission matrix instead: an alert goes to whoever holds the area that owns
 * the work the alert is asking for. A Full Admin holds every area at `edit`, so
 * their audience is unchanged.
 *
 * The required level is `edit`, not `view`, deliberately. An alert is a request
 * to act, so its audience is the people who can act. The scoped bundles are
 * also broadly view-heavy — a Booking Officer carries `finance: view`,
 * `membership: view` and `support: view` — so a `view` threshold would post
 * payment failures, Xero errors, refund appeals and member requests to every
 * officer in the club, which is the privacy widening the owner's decision
 * (2 Aug 2026) explicitly rules out ("each scoped role defaults ON for its own
 * area's keys and OFF for other areas' keys"). Clubs that want a wider audience
 * grant the area, or build a custom access role that does — the permission
 * matrix stays the single source of truth.
 *
 * Note this is only the AUDIENCE gate. `/admin/notification-rules` delivery
 * policies still sit upstream of it and can mute a template club-wide for
 * everyone regardless of area or preference.
 */
export const ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT: Record<
  AdminNotificationPreferenceKey,
  AdminAccessRequirement
> = {
  adminNewBooking: { area: "bookings", level: "edit" },
  adminPaymentFailure: { area: "finance", level: "edit" },
  adminPendingDeadline: { area: "bookings", level: "edit" },
  adminBookingBumped: { area: "bookings", level: "edit" },
  adminXeroSyncError: { area: "finance", level: "edit" },
  adminCapacityWarning: { area: "bookings", level: "edit" },
  // Cross-area summary of the previous 24 hours of admin alerts, so it needs
  // the cross-area role: `overview: edit` is the Full Admin bundle (and any
  // custom role a club deliberately builds to match it).
  adminDailyDigest: { area: "overview", level: "edit" },
  adminWaitlistOffer: { area: "bookings", level: "edit" },
  adminFamilyGroupRequest: { area: "membership", level: "edit" },
  adminBookingChangeRequest: { area: "bookings", level: "edit" },
  adminRefundRequest: { area: "finance", level: "edit" },
  // Reported site issues are triaged from /admin/issue-reports, a Support &
  // System surface.
  adminIssueReport: { area: "support", level: "edit" },
  adminBookingRequest: { area: "bookings", level: "edit" },
  adminBookingReviewRequired: { area: "bookings", level: "edit" },
  adminMemberDeleteRequest: { area: "membership", level: "edit" },
  // #2780. THIS IS WHAT "THE MAINTENANCE OFFICER" MEANS IN A PRODUCT THAT MUST
  // NOT ENCODE ONE CLUB'S COMMITTEE. There is no maintenance-officer role here
  // and adding one would be a permission-model change every adopter inherits;
  // instead the alert goes to whoever the club has given Lodge Operations edit
  // to, which is where hut leaders, rosters, work parties and lodge settings
  // already live. A club whose maintenance officer is not otherwise a lodge
  // admin grants them that area, or builds a custom access role that does.
  adminMaintenanceReport: { area: "lodge", level: "edit" },
};

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
  adminFamilyGroupRequest: true,
  adminBookingChangeRequest: true,
  adminRefundRequest: true,
  adminIssueReport: true,
  adminBookingRequest: true,
  adminBookingReviewRequired: true,
  adminMemberDeleteRequest: true,
  adminMaintenanceReport: true,
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
    adminFamilyGroupRequest: preferences?.adminFamilyGroupRequest ?? true,
    adminBookingChangeRequest: preferences?.adminBookingChangeRequest ?? true,
    adminRefundRequest: preferences?.adminRefundRequest ?? true,
    adminIssueReport: preferences?.adminIssueReport ?? true,
    adminBookingRequest: preferences?.adminBookingRequest ?? true,
    adminBookingReviewRequired: preferences?.adminBookingReviewRequired ?? true,
    adminMemberDeleteRequest: preferences?.adminMemberDeleteRequest ?? true,
    adminMaintenanceReport: preferences?.adminMaintenanceReport ?? true,
  };
}

/**
 * Can this admin user receive this alert category at all (#2548)? True when
 * their merged access-role matrix meets the category's area requirement.
 * `canLogin: false`, a deactivated-role member and a plain member all resolve
 * to the empty matrix and therefore to false.
 */
export function canReceiveAdminNotification(
  input: AdminPermissionInput,
  key: AdminNotificationPreferenceKey,
): boolean {
  return hasAdminAreaAccess(input, ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT[key]);
}

/** The alert categories this admin user's areas cover, in display order. */
export function adminNotificationKeysForMember(
  input: AdminPermissionInput,
): AdminNotificationPreferenceKey[] {
  return ADMIN_NOTIFICATION_PREFERENCE_KEYS.filter((key) =>
    canReceiveAdminNotification(input, key),
  );
}

/**
 * The role/context-aware default matrix (#2548): every category the member's
 * areas cover is ON, every other category is OFF. A Full Admin holds every
 * area, so they default to all-on exactly as before; a Booking Officer defaults
 * to the booking categories only.
 *
 * This is derived, never stored — NO NotificationPreference row is created or
 * rewritten to express it. That matters because the stored `admin*` columns are
 * non-null with a database default of `true`, so any member who ever saved a
 * personal email preference already carries fifteen `true`s they never chose.
 * Masking by area at resolve time is what stops those incidental `true`s from
 * mailing a Booking Officer the club's refund appeals and Xero errors.
 */
export function resolveEffectiveAdminNotificationPreferences(
  input: AdminPermissionInput,
  preferences?: Partial<AdminNotificationPreferences> | null,
): AdminNotificationPreferences {
  const stored = resolveAdminNotificationPreferences(preferences);
  return Object.fromEntries(
    ADMIN_NOTIFICATION_PREFERENCE_KEYS.map((key) => [
      key,
      canReceiveAdminNotification(input, key) && stored[key],
    ]),
  ) as AdminNotificationPreferences;
}

/**
 * Who belongs on the Recipients grid (#2548, owner decision 2 Aug 2026): every
 * admin-portal user, not just Full Admins — scoped officers and holders of
 * definition-backed custom roles included. A member with portal access but no
 * matching categories (a read-only admin) still appears, with the grid
 * explaining why nothing is available.
 *
 * The second arm is no longer reachable on its own and is kept deliberately.
 * It was written because finance-only roles had no portal standing yet owned
 * the finance alerts; #2984 gave them that standing, so `hasAdminPortalAccess`
 * now covers them and the category arm adds nobody today. It stays because the
 * two conditions are independent claims — "is an administrator" and "owns an
 * alert category" — and a club that builds a custom grid the portal check ever
 * stops recognising must not silently lose its alerts.
 *
 * This widens who is LISTED, never who is MAILED. Every send still resolves
 * through `resolveEffectiveAdminNotificationPreferences`, which masks each
 * category by the recipient's own area, so a finance-view-only member appears
 * on the roster with nothing switchable and receives nothing.
 */
export function isAdminNotificationRecipient(
  input: AdminPermissionInput,
): boolean {
  return (
    hasAdminPortalAccess(input) ||
    ADMIN_NOTIFICATION_PREFERENCE_KEYS.some((key) =>
      canReceiveAdminNotification(input, key),
    )
  );
}

/**
 * Who may READ the Recipients roster (#2548, review finding 1).
 *
 * `/admin/notification-recipients` resolves to `support: view` in
 * ROUTE_AREA_PREFIXES, and that is still what admits a visitor to the page. But
 * the roster itself is member identity data — every privileged user's name,
 * email address and access-role labels, i.e. a complete "who holds which admin
 * role" census — and while the grid only listed Full Admins that was a handful
 * of already-published committee addresses. Now that it lists every admin-level
 * user, the disclosure matches what `/api/admin/members` returns (each member's
 * email plus their resolved access-role tokens), and that route is gated at
 * `membership: view`. So the roster is gated at the same level here rather than
 * at the weaker route area.
 *
 * `support: edit` is accepted as well because it is the capability this page
 * exists to exercise — the PUT route already requires it — so a club-built
 * "system support" role must not be locked out of its own tool. Every seeded
 * bundle that carries `support: view` (Full Admin, Read-only Admin, Booking
 * Officer, Membership Officer, Treasurer) also carries `membership: view`, so no
 * seeded role loses access; the case this closes is a custom role holding
 * support view alone.
 */
export function canViewAdminNotificationRoster(
  input: AdminPermissionInput,
): boolean {
  return (
    hasAdminAreaAccess(input, { area: "membership", level: "view" }) ||
    hasAdminAreaAccess(input, { area: "support", level: "edit" })
  );
}
