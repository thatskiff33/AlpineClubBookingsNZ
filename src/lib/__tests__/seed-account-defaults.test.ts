/**
 * Issue #703: club-agnostic seed and first-run admin setup.
 *
 * Covers the seed account builders (canLogin / emailVerified /
 * forcePasswordChange / subscription defaults), the generic committee and
 * chore placeholders, and the Xero-off booking-time subscription bypass.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgeTierSettingData } from "@/lib/age-tier";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLoadEffectiveModuleFlags = vi.fn();
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return {
    ...actual,
    loadEffectiveModuleFlags: (...args: unknown[]) =>
      mockLoadEffectiveModuleFlags(...args),
  };
});

const mockGetAgeTierSettings = vi.fn();
vi.mock("@/lib/age-tier", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/age-tier")>();
  return {
    ...actual,
    getAgeTierSettings: (...args: unknown[]) => mockGetAgeTierSettings(...args),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildSeedAdminMemberData,
  buildSeedChoreTemplates,
  buildSeedCommitteePlaceholders,
  buildSeedLodgeMemberData,
  SEED_PLACEHOLDER_PHONE,
} from "../../../prisma/seed-data";
import {
  ensureNotRequiredSubscriptionForRole,
  roleNeverRequiresSubscription,
} from "@/lib/member-subscription-defaults";
import {
  isSubscriptionEnforcementActive,
  requiresPaidSubscriptionForBooking,
} from "@/lib/member-subscription-eligibility";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";

function moduleFlags(xeroIntegration: boolean) {
  return {
    kiosk: true,
    chores: true,
    financeDashboard: true,
    waitlist: true,
    xeroIntegration,
    bedAllocation: true,
    internetBankingPayments: false,
  };
}

const adultRequiresSubscription: AgeTierSettingData[] = [
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult",
    subscriptionRequiredForBooking: true,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 17,
    label: "Child",
    subscriptionRequiredForBooking: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadEffectiveModuleFlags.mockResolvedValue(moduleFlags(true));
  mockGetAgeTierSettings.mockResolvedValue(adultRequiresSubscription);
});

// ── Seeded account defaults ──────────────────────────────────────────────────

describe("buildSeedAdminMemberData", () => {
  it("creates a login-capable verified admin that must change password", () => {
    const data = buildSeedAdminMemberData({
      email: "admin@example.org",
      passwordHash: "hash",
    });

    expect(data.role).toBe("ADMIN");
    expect(data.canLogin).toBe(true);
    expect(data.emailVerified).toBe(true);
    expect(data.forcePasswordChange).toBe(true);
    expect(data.ageTier).toBe("ADULT");
    expect(data.firstName).toBe("Admin");
    expect(data.lastName).toBe("User");
  });

  it("uses optional SEED_ADMIN_* names when provided, trimming whitespace", () => {
    const data = buildSeedAdminMemberData({
      email: "admin@example.org",
      passwordHash: "hash",
      firstName: "  Alex ",
      lastName: " Example ",
    });

    expect(data.firstName).toBe("Alex");
    expect(data.lastName).toBe("Example");
  });

  it("falls back to generic names when env values are blank", () => {
    const data = buildSeedAdminMemberData({
      email: "admin@example.org",
      passwordHash: "hash",
      firstName: "   ",
      lastName: "",
    });

    expect(data.firstName).toBe("Admin");
    expect(data.lastName).toBe("User");
  });
});

describe("buildSeedLodgeMemberData", () => {
  it("creates a login-capable kiosk account without forced password change", () => {
    const data = buildSeedLodgeMemberData({
      email: "lodge@example.org",
      passwordHash: "hash",
    });

    expect(data.role).toBe("LODGE");
    expect(data.canLogin).toBe(true);
    expect(data.emailVerified).toBe(true);
    expect(data.forcePasswordChange).toBe(false);
  });
});

// ── Generic placeholder content ──────────────────────────────────────────────

describe("buildSeedCommitteePlaceholders", () => {
  const placeholders = buildSeedCommitteePlaceholders({
    domainEmail: (localPart) => `${localPart}@example.org`,
    contactEmail: "bookings@example.org",
  });

  it("contains only clearly generic names and the placeholder phone", () => {
    for (const entry of placeholders) {
      expect(entry.name).toBe(`Example ${entry.role}`);
      expect(entry.phone).toBe(SEED_PLACEHOLDER_PHONE);
    }
  });

  it("derives emails from club config rather than hardcoding them", () => {
    for (const entry of placeholders) {
      if (entry.email !== null) {
        expect(entry.email.endsWith("@example.org")).toBe(true);
      }
    }
  });

  it("keeps the booking officer wired to the club contact email", () => {
    const bookings = placeholders.find((entry) => entry.contactKey === "bookings");
    expect(bookings?.email).toBe("bookings@example.org");
  });

  it("uses stable ids and sequential sort order for create-if-missing seeding", () => {
    placeholders.forEach((entry, index) => {
      expect(entry.id).toBe(`seed-committee-${entry.contactKey}`);
      expect(entry.sortOrder).toBe(index);
    });
  });
});

describe("buildSeedChoreTemplates", () => {
  it("contains no location-specific copy", () => {
    const text = JSON.stringify(buildSeedChoreTemplates());
    // Previously the seed referenced a specific recycling centre and supply days.
    expect(text).not.toMatch(/Iwikau|Ruapehu|Whakapapa|Tokoroa/i);
  });

  it("keeps the full example template set", () => {
    expect(buildSeedChoreTemplates()).toHaveLength(17);
  });
});

// ── Subscription defaults for operational roles ──────────────────────────────

describe("ensureNotRequiredSubscriptionForRole", () => {
  function makeDb() {
    return { memberSubscription: { upsert: vi.fn().mockResolvedValue({}) } };
  }

  it("creates a NOT_REQUIRED subscription for ADMIN without overwriting", async () => {
    const db = makeDb();
    await ensureNotRequiredSubscriptionForRole(db, { id: "m1", role: "ADMIN" }, 2026);

    expect(db.memberSubscription.upsert).toHaveBeenCalledWith({
      where: { memberId_seasonYear: { memberId: "m1", seasonYear: 2026 } },
      update: {},
      create: { memberId: "m1", seasonYear: 2026, status: "NOT_REQUIRED" },
    });
  });

  it("creates a NOT_REQUIRED subscription for LODGE", async () => {
    const db = makeDb();
    await ensureNotRequiredSubscriptionForRole(db, { id: "m2", role: "LODGE" }, 2026);

    expect(db.memberSubscription.upsert).toHaveBeenCalledTimes(1);
  });

  it("does nothing for ordinary members", async () => {
    const db = makeDb();
    await ensureNotRequiredSubscriptionForRole(db, { id: "m3", role: "MEMBER" }, 2026);

    expect(db.memberSubscription.upsert).not.toHaveBeenCalled();
  });

  it("classifies only ADMIN and LODGE as never owing a subscription", () => {
    expect(roleNeverRequiresSubscription("ADMIN")).toBe(true);
    expect(roleNeverRequiresSubscription("LODGE")).toBe(true);
    expect(roleNeverRequiresSubscription("MEMBER")).toBe(false);
  });
});

// ── Xero-off subscription enforcement bypass ─────────────────────────────────

describe("isSubscriptionEnforcementActive", () => {
  it("is active when the Xero module is effectively on", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue(moduleFlags(true));
    await expect(isSubscriptionEnforcementActive()).resolves.toBe(true);
  });

  it("is inactive when the Xero module is effectively off", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));
    await expect(isSubscriptionEnforcementActive()).resolves.toBe(false);
  });
});

describe("requiresPaidSubscriptionForBooking", () => {
  it("enforces the age-tier rule while the Xero module is on", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue(moduleFlags(true));

    await expect(requiresPaidSubscriptionForBooking("ADULT")).resolves.toBe(true);
    await expect(requiresPaidSubscriptionForBooking("CHILD")).resolves.toBe(false);
  });

  it("never requires a paid subscription while the Xero module is off", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));

    await expect(requiresPaidSubscriptionForBooking("ADULT")).resolves.toBe(false);
    // Short-circuits before consulting age-tier settings.
    expect(mockGetAgeTierSettings).not.toHaveBeenCalled();
  });
});

describe("findUnpaidMemberGuests Xero-off bypass", () => {
  function makeDb() {
    return {
      memberSubscription: { findMany: vi.fn().mockResolvedValue([]) },
      member: {
        findMany: vi.fn().mockResolvedValue([
          { id: "g1", firstName: "Guest", lastName: "One", ageTier: "ADULT" },
        ]),
      },
    };
  }
  const params = {
    bookingMemberId: "owner-1",
    checkIn: new Date("2026-07-01"),
    guests: [{ isMember: true, memberId: "g1" }],
  };

  it("reports unpaid member guests while the Xero module is on", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue(moduleFlags(true));
    const db = makeDb();

    const unpaid = await findUnpaidMemberGuests(db, params);

    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]).toMatchObject({ memberId: "g1", status: "NOT_INVOICED" });
  });

  it("returns no unpaid guests while the Xero module is off", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue(moduleFlags(false));
    const db = makeDb();

    const unpaid = await findUnpaidMemberGuests(db, params);

    expect(unpaid).toEqual([]);
    // Short-circuits before querying subscriptions or members.
    expect(db.memberSubscription.findMany).not.toHaveBeenCalled();
    expect(db.member.findMany).not.toHaveBeenCalled();
  });
});
