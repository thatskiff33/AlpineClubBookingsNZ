import { describe, expect, it } from "vitest";

import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT,
  adminNotificationKeysForMember,
  canReceiveAdminNotification,
  canViewAdminNotificationRoster,
  isAdminNotificationRecipient,
  resolveEffectiveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";
import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";

/**
 * #2548: admin alert audiences are area-aware. These are the pure
 * default-matrix rules — which alert categories each kind of admin holds before
 * anybody edits the Recipients grid. The delivery side (who is actually emailed)
 * is covered in src/lib/email/__tests__/admin-alert-audience.test.ts.
 */

const BOOKING_KEYS = [
  "adminNewBooking",
  "adminPendingDeadline",
  "adminBookingBumped",
  "adminCapacityWarning",
  "adminWaitlistOffer",
  "adminBookingChangeRequest",
  "adminBookingRequest",
  "adminBookingReviewRequired",
] as const;
const FINANCE_KEYS = [
  "adminPaymentFailure",
  "adminXeroSyncError",
  "adminRefundRequest",
] as const;
const MEMBERSHIP_KEYS = [
  "adminFamilyGroupRequest",
  "adminMemberDeleteRequest",
] as const;
// #2780: the first `lodge`-area alert, joined by #49's central-server-version
// digest entry. A Booking Officer holds lodge:edit ("manage bed allocation and
// lodge operations"), so both reach them — see the Booking Officer test below.
const LODGE_KEYS = ["adminMaintenanceReport", "adminServerVersion"] as const;

function member(role: string) {
  return { accessRoles: [{ role }], canLogin: true };
}

/** A definition-backed CUSTOM role: `role` is null, the matrix is the row. */
function customRole(
  levels: Partial<Record<string, "NONE" | "VIEW" | "EDIT">>,
  options: { canLogin?: boolean } = {},
) {
  return {
    canLogin: options.canLogin ?? true,
    accessRoles: [
      {
        role: null,
        roleDefinitionId: "ardef_custom",
        roleDefinition: {
          id: "ardef_custom",
          overviewLevel: "NONE" as const,
          bookingsLevel: "NONE" as const,
          membershipLevel: "NONE" as const,
          financeLevel: "NONE" as const,
          lodgeLevel: "NONE" as const,
          contentLevel: "NONE" as const,
          supportLevel: "NONE" as const,
          ...levels,
        },
      },
    ],
  };
}

describe("admin notification category → permission area map (#2548)", () => {
  it("maps every preference key to a known admin permission area", () => {
    const areas = ADMIN_PERMISSION_AREAS.map((area) => area.key);
    for (const key of ADMIN_NOTIFICATION_PREFERENCE_KEYS) {
      const requirement = ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT[key];
      expect(requirement, `${key} has no area requirement`).toBeDefined();
      expect(areas).toContain(requirement.area);
      // Alerts are requests to act, so they follow edit access. `view` would
      // post finance and membership alerts to every scoped officer, because
      // the scoped bundles all carry view on the areas they do not own.
      expect(requirement.level).toBe("edit");
    }
  });

  it("has a requirement for exactly the seventeen preference keys", () => {
    expect(Object.keys(ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT).sort()).toEqual(
      [...ADMIN_NOTIFICATION_PREFERENCE_KEYS].sort(),
    );
  });
});

describe("default alert matrix per role (#2548)", () => {
  it("gives a Full Admin every category, exactly as before", () => {
    expect(adminNotificationKeysForMember(member("ADMIN"))).toEqual(
      ADMIN_NOTIFICATION_PREFERENCE_KEYS,
    );
    const defaults = resolveEffectiveAdminNotificationPreferences(
      member("ADMIN"),
      null,
    );
    expect(Object.values(defaults).every(Boolean)).toBe(true);
  });

  it("gives a Booking Officer the booking categories plus the lodge maintenance alert", () => {
    // The Booking Officer bundle holds bookings:edit AND lodge:edit ("manage
    // bookings, bed allocation, and lodge operations"), so it receives the
    // bookings-area alerts and the one lodge-area alert (#2780) — and nothing
    // from finance/membership/support, which it holds only at `view`.
    const keys = adminNotificationKeysForMember(member("ADMIN_BOOKINGS"));
    expect([...keys].sort()).toEqual([...BOOKING_KEYS, ...LODGE_KEYS].sort());

    const defaults = resolveEffectiveAdminNotificationPreferences(
      member("ADMIN_BOOKINGS"),
      null,
    );
    // The alert the owner expected to already reach them (#2542, #2548).
    expect(defaults.adminBookingChangeRequest).toBe(true);
    // The lodge-area maintenance alert reaches them because they manage lodge
    // operations — deliberate, not a leak (#2780). A custom role with
    // bookings:edit but lodge:NONE does NOT get it (see the custom-role test).
    expect(defaults.adminMaintenanceReport).toBe(true);
    // …and the ones that must NOT start reaching them, even though the Booking
    // Officer bundle carries finance/membership/support at `view`.
    expect(defaults.adminPaymentFailure).toBe(false);
    expect(defaults.adminXeroSyncError).toBe(false);
    expect(defaults.adminRefundRequest).toBe(false);
    expect(defaults.adminFamilyGroupRequest).toBe(false);
    expect(defaults.adminIssueReport).toBe(false);
    expect(defaults.adminDailyDigest).toBe(false);
  });

  it("gives a Membership Officer the membership categories only", () => {
    expect([...adminNotificationKeysForMember(member("ADMIN_MEMBERSHIP"))].sort()).toEqual(
      [...MEMBERSHIP_KEYS].sort(),
    );
  });

  it("gives a Treasurer the finance categories only", () => {
    expect([...adminNotificationKeysForMember(member("FINANCE_ADMIN"))].sort()).toEqual(
      [...FINANCE_KEYS].sort(),
    );
  });

  it("gives a Read-only Admin and a Content Manager nothing to receive", () => {
    expect(adminNotificationKeysForMember(member("ADMIN_READONLY"))).toEqual([]);
    expect(adminNotificationKeysForMember(member("ADMIN_CONTENT"))).toEqual([]);
  });

  it("gives a plain member nothing", () => {
    expect(adminNotificationKeysForMember(member("USER"))).toEqual([]);
    expect(adminNotificationKeysForMember({ accessRoles: [], canLogin: true })).toEqual(
      [],
    );
  });

  it("resolves a definition-backed custom role instead of silently dropping it", () => {
    const officer = customRole({ overviewLevel: "VIEW", bookingsLevel: "EDIT" });
    expect([...adminNotificationKeysForMember(officer)].sort()).toEqual(
      [...BOOKING_KEYS].sort(),
    );
    expect(canReceiveAdminNotification(officer, "adminBookingChangeRequest")).toBe(
      true,
    );
    expect(canReceiveAdminNotification(officer, "adminRefundRequest")).toBe(false);
    expect(isAdminNotificationRecipient(officer)).toBe(true);
  });

  it("gives a custom role with overview edit the cross-area daily digest", () => {
    expect(
      canReceiveAdminNotification(
        customRole({ overviewLevel: "EDIT" }),
        "adminDailyDigest",
      ),
    ).toBe(true);
  });

  it("clears every category when login is disabled", () => {
    expect(
      adminNotificationKeysForMember({
        accessRoles: [{ role: "ADMIN" }],
        canLogin: false,
      }),
    ).toEqual([]);
    expect(
      adminNotificationKeysForMember(
        customRole({ bookingsLevel: "EDIT" }, { canLogin: false }),
      ),
    ).toEqual([]);
    expect(
      isAdminNotificationRecipient({
        accessRoles: [{ role: "ADMIN" }],
        canLogin: false,
      }),
    ).toBe(false);
  });
});

describe("stored preferences vs area mask (#2548)", () => {
  it("never turns a stored true into delivery outside the member's areas", () => {
    // The `admin*` columns are non-null and default to TRUE in the database, so
    // any officer who ever saved a personal email preference carries sixteen
    // `true`s they never chose. The mask is what stops those reaching them.
    const allStoredOn = Object.fromEntries(
      ADMIN_NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, true]),
    );
    const effective = resolveEffectiveAdminNotificationPreferences(
      member("ADMIN_BOOKINGS"),
      allStoredOn,
    );
    expect(effective.adminPaymentFailure).toBe(false);
    expect(effective.adminNewBooking).toBe(true);
  });

  it("still honours an explicit opt-out inside the member's own area", () => {
    const effective = resolveEffectiveAdminNotificationPreferences(
      member("ADMIN_BOOKINGS"),
      { adminBookingChangeRequest: false },
    );
    expect(effective.adminBookingChangeRequest).toBe(false);
    expect(effective.adminNewBooking).toBe(true);
  });

  it("leaves the Full Admin resolution unchanged by the mask", () => {
    const effective = resolveEffectiveAdminNotificationPreferences(member("ADMIN"), {
      adminNewBooking: false,
    });
    expect(effective.adminNewBooking).toBe(false);
    expect(effective.adminPaymentFailure).toBe(true);
    expect(effective.adminDailyDigest).toBe(true);
  });
});

describe("Recipients grid eligibility (#2548)", () => {
  it("includes scoped officers and read-only admins, not plain members", () => {
    expect(isAdminNotificationRecipient(member("ADMIN"))).toBe(true);
    expect(isAdminNotificationRecipient(member("ADMIN_BOOKINGS"))).toBe(true);
    expect(isAdminNotificationRecipient(member("ADMIN_MEMBERSHIP"))).toBe(true);
    expect(isAdminNotificationRecipient(member("FINANCE_ADMIN"))).toBe(true);
    // Portal access but no editable alert area: listed so an operator can see
    // why they receive nothing.
    expect(isAdminNotificationRecipient(member("ADMIN_READONLY"))).toBe(true);
    expect(isAdminNotificationRecipient(member("USER"))).toBe(false);
    expect(isAdminNotificationRecipient(member("LODGE"))).toBe(false);
  });

  it("includes a finance-only custom role that owns finance alerts", () => {
    // No admin-portal access (finance is excluded from the portal check), but
    // it can be sent finance alerts, so it must be configurable.
    const financeOnly = customRole({ financeLevel: "EDIT" });
    expect(isAdminNotificationRecipient(financeOnly)).toBe(true);
    expect([...adminNotificationKeysForMember(financeOnly)].sort()).toEqual(
      [...FINANCE_KEYS].sort(),
    );
  });
});

/**
 * #2548 review finding 1: the grid now discloses every privileged user's name,
 * email and access role, so reading it needs the same level `/api/admin/members`
 * needs for the same data (membership view) — or support edit, the capability
 * the page exists to exercise. The route area that ADMITS a visitor is still the
 * weaker `support: view`, hence a separate gate.
 */
describe("Recipients roster read gate (#2548)", () => {
  it("admits every built-in admin role that can open the page", () => {
    expect(canViewAdminNotificationRoster(member("ADMIN"))).toBe(true);
    expect(canViewAdminNotificationRoster(member("ADMIN_READONLY"))).toBe(true);
    expect(canViewAdminNotificationRoster(member("ADMIN_BOOKINGS"))).toBe(true);
    expect(canViewAdminNotificationRoster(member("ADMIN_MEMBERSHIP"))).toBe(true);
    expect(canViewAdminNotificationRoster(member("FINANCE_ADMIN"))).toBe(true);
  });

  it("withholds the roster from a custom role holding support view alone", () => {
    // The gap this closes: support view admits to the page, but it is not the
    // level at which this club exposes member names, emails and role tokens.
    const supportViewOnly = customRole({ supportLevel: "VIEW" });
    expect(canViewAdminNotificationRoster(supportViewOnly)).toBe(false);
  });

  it("admits a support-edit custom role with no membership access", () => {
    // It can already PUT preferences for anyone, so locking it out of the
    // roster would break its own tool without withholding anything.
    expect(
      canViewAdminNotificationRoster(customRole({ supportLevel: "EDIT" })),
    ).toBe(true);
  });

  it("admits a membership-view custom role with no support access", () => {
    expect(
      canViewAdminNotificationRoster(customRole({ membershipLevel: "VIEW" })),
    ).toBe(true);
  });

  it("withholds the roster from plain members and disabled logins", () => {
    expect(canViewAdminNotificationRoster(member("USER"))).toBe(false);
    expect(
      canViewAdminNotificationRoster({
        accessRoles: [{ role: "ADMIN" }],
        canLogin: false,
      }),
    ).toBe(false);
  });
});
