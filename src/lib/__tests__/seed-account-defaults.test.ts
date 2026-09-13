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
  const actual = (await importOriginal()) as typeof import("@/lib/module-settings");
  return {
    ...actual,
    loadEffectiveModuleFlags: (...args: unknown[]) =>
      mockLoadEffectiveModuleFlags(...args),
  };
});

const mockGetAgeTierSettings = vi.fn();
vi.mock("@/lib/age-tier", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/age-tier");
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
  buildSeedCommitteeRoles,
  buildSeedLodgeMemberData,
} from "../../../prisma/seed-data";
import { starterPageContent } from "../../../prisma/starter-page-content";
import { starterSiteContent } from "../../../prisma/starter-site-content";
import {
  ensureDefaultSeasonSubscriptionForNewMember,
  reconcileSeasonSubscriptionForAssignment,
} from "@/lib/member-subscription-defaults";
import { ensureMemberAccessRolesFromCompatibilityFields } from "@/lib/member-access-role-writes";
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
    sortOrder: 0,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 17,
    label: "Child",
    subscriptionRequiredForBooking: false,
    sortOrder: 1,
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

describe("buildSeedCommitteeRoles", () => {
  const roles = buildSeedCommitteeRoles();

  it("creates stable master role records from the generic committee positions", () => {
    expect(roles.map((role) => role.key)).toEqual([
      "president",
      "vicePresident",
      "secretary",
      "treasurer",
      "membership",
      "bookings",
      "custodian",
    ]);
    roles.forEach((role, index) => {
      expect(role.id).toBe(`seed-committee-role-${role.key}`);
      expect(role.contactEmail).toBe("committee@example.invalid");
      expect(role.sortOrder).toBe(index);
    });
  });

  it("derives master role contact emails from club aliases when configured", () => {
    const configuredRoles = buildSeedCommitteeRoles({
      domainEmail: (localPart) => `${localPart}@club.example`,
      contactEmail: "bookings@club.example",
    });

    expect(
      configuredRoles.find((role) => role.key === "president")?.contactEmail,
    ).toBe("president@club.example");
    expect(
      configuredRoles.find((role) => role.key === "bookings")?.contactEmail,
    ).toBe("bookings@club.example");
  });
});

describe("ensureMemberAccessRolesFromCompatibilityFields", () => {
  function makeDb() {
    return {
      memberAccessRole: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      accessRoleDefinition: {
        // Empty definitions: rows are written enum-only, like pre-seed
        // installs; ensureAccessRoleDefinitions re-links them later.
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
  }

  it("writes the seeded ADMIN access role create-if-missing", async () => {
    const db = makeDb();

    await ensureMemberAccessRolesFromCompatibilityFields(db, {
      memberId: "admin-1",
      role: "ADMIN",
      financeAccessLevel: "NONE",
      canLogin: true,
    });

    expect(db.memberAccessRole.createMany).toHaveBeenCalledWith({
      data: [{ memberId: "admin-1", role: "ADMIN", roleDefinitionId: null }],
      skipDuplicates: true,
    });
  });

  it("does not grant access roles to non-login records", async () => {
    const db = makeDb();

    await ensureMemberAccessRolesFromCompatibilityFields(db, {
      memberId: "child-1",
      role: "USER",
      canLogin: false,
    });

    expect(db.memberAccessRole.createMany).not.toHaveBeenCalled();
  });
});

// The founding club's lodge name and the geography around it. This project is
// a reusable product: none of these may appear in anything a fresh install
// seeds, because the club installing it is somewhere else entirely. One shared
// constant so the three surfaces below cannot drift apart (#1945, #2484,
// #2490). Not a global regex, so repeated .test/.toMatch calls are independent.
const FOUNDING_CLUB_GEOGRAPHY = /Waldvogel|Iwikau|Ruapehu|Whakapapa|Tokoroa/i;

describe("buildSeedChoreTemplates", () => {
  it("contains no location-specific copy", () => {
    const text = JSON.stringify(buildSeedChoreTemplates());
    // Previously the seed referenced a specific recycling centre and supply days.
    // Waldvogel is added for symmetry with the starter-content guards below.
    expect(text).not.toMatch(FOUNDING_CLUB_GEOGRAPHY);
  });

  it("keeps the full example template set", () => {
    expect(buildSeedChoreTemplates()).toHaveLength(17);
  });
});

describe("starterPageContent location scrub (#1945)", () => {
  it("seeds no club-specific lodge name or geography", () => {
    // The public repo must not ship the founding club's lodge name/geography in
    // fresh-install starter pages; content is club-agnostic and token-driven
    // ({{club-name}} / {{lodge-name}} / {{lodge-capacity}}). This guard fails if
    // any of those names re-enter the seeded privacy, terms, or FAQ copy.
    const text = JSON.stringify(starterPageContent);
    expect(text).not.toMatch(FOUNDING_CLUB_GEOGRAPHY);
  });
});

describe("starterSiteContent location scrub (#2490)", () => {
  // The arm of this guard that was missing until #2490. The starter footer
  // columns render on EVERY public page, and the affiliations column shipped a
  // link to the Ruapehu Mountain Clubs Association — a regional body a club in
  // another region does not belong to — which no guard could see, because this
  // suite only ever covered buildSeedChoreTemplates() and starterPageContent.
  it("seeds no club-specific affiliation, lodge name, or geography", () => {
    const text = JSON.stringify(starterSiteContent);
    expect(text).not.toMatch(FOUNDING_CLUB_GEOGRAPHY);
  });

  it("covers every starter site content section, not just the footer keys", () => {
    // Fails if a section is added without content the guard above can read, so
    // a future column cannot slip club-specific copy past a stale field list.
    expect(starterSiteContent.length).toBeGreaterThan(0);
    for (const section of starterSiteContent) {
      expect(typeof section.contentHtml).toBe("string");
      expect(section.contentHtml).not.toMatch(FOUNDING_CLUB_GEOGRAPHY);
    }
  });

  it("lists no affiliations at all on a fresh install", () => {
    // The recorded decision (#2490): this project cannot know a club's
    // affiliations, so it ships none and the footer hides the column until an
    // admin adds the club's own.
    const affiliations = starterSiteContent.find(
      (section) => section.key === "FOOTER_AFFILIATIONS",
    );
    expect(affiliations).toBeDefined();
    expect(affiliations!.contentHtml).toBe("");
  });
});

// ── Subscription defaults for operational roles ──────────────────────────────

describe("ensureDefaultSeasonSubscriptionForNewMember", () => {
  function makeDb() {
    return { memberSubscription: { upsert: vi.fn().mockResolvedValue({}) } };
  }

  it("creates a NOT_REQUIRED subscription for ADMIN without overwriting", async () => {
    const db = makeDb();
    await ensureDefaultSeasonSubscriptionForNewMember(db, { id: "m1", role: "ADMIN" }, 2026);

    expect(db.memberSubscription.upsert).toHaveBeenCalledWith({
      where: { memberId_seasonYear: { memberId: "m1", seasonYear: 2026 } },
      update: {},
      create: { memberId: "m1", seasonYear: 2026, status: "NOT_REQUIRED" },
    });
  });

  it("creates a NOT_REQUIRED subscription for LODGE", async () => {
    const db = makeDb();
    await ensureDefaultSeasonSubscriptionForNewMember(db, { id: "m2", role: "LODGE" }, 2026);

    expect(db.memberSubscription.upsert).toHaveBeenCalledTimes(1);
  });

  it("creates a NOT_REQUIRED subscription for NON_MEMBER and SCHOOL", async () => {
    for (const role of ["NON_MEMBER", "SCHOOL"] as const) {
      const db = makeDb();
      await ensureDefaultSeasonSubscriptionForNewMember(db, { id: role, role }, 2026);
      expect(db.memberSubscription.upsert).toHaveBeenCalledTimes(1);
    }
  });

  it("does nothing for ordinary members (USER → FULL/REQUIRED)", async () => {
    const db = makeDb();
    await ensureDefaultSeasonSubscriptionForNewMember(db, { id: "m3", role: "USER" }, 2026);

    expect(db.memberSubscription.upsert).not.toHaveBeenCalled();
  });
});

describe("reconcileSeasonSubscriptionForAssignment", () => {
  function makeReconcileDb(
    existing: {
      status: string;
      xeroInvoiceId: string | null;
      manuallyMarkedPaidAt: Date | null;
      // #2147/#2179: chargeCoverage is a to-many relation — the real client
      // ALWAYS returns an array (never null), here already narrowed to ACTIVE
      // claims by the select's `where: { releasedAt: null }`.
      chargeCoverage: Array<{ id: string }>;
    } | null,
    updateCount = 1,
  ) {
    return {
      memberSubscription: {
        findUnique: vi.fn().mockResolvedValue(existing),
        updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
      },
    };
  }

  const untouchedSeedRow = {
    status: "NOT_REQUIRED",
    xeroInvoiceId: null,
    manuallyMarkedPaidAt: null,
    chargeCoverage: [] as Array<{ id: string }>,
  };

  it("flips a stale NOT_REQUIRED seed row to NOT_INVOICED for a REQUIRED type", async () => {
    const db = makeReconcileDb(untouchedSeedRow);
    const result = await reconcileSeasonSubscriptionForAssignment(db as never, {
      memberId: "m1",
      seasonYear: 2026,
      subscriptionBehavior: "REQUIRED",
    });

    expect(result).toEqual({ reconciled: true });
    // #2179: the coverage read must count ACTIVE claims only (a released claim
    // means the member is re-billable and must not block the reconcile).
    expect(db.memberSubscription.findUnique).toHaveBeenCalledWith({
      where: { memberId_seasonYear: { memberId: "m1", seasonYear: 2026 } },
      select: {
        status: true,
        xeroInvoiceId: true,
        manuallyMarkedPaidAt: true,
        chargeCoverage: {
          where: { releasedAt: null },
          take: 1,
          select: { id: true },
        },
      },
    });
    expect(db.memberSubscription.updateMany).toHaveBeenCalledWith({
      where: {
        memberId: "m1",
        seasonYear: 2026,
        status: "NOT_REQUIRED",
        xeroInvoiceId: null,
        manuallyMarkedPaidAt: null,
        // #2179: the no-active-coverage guard is re-asserted relationally at
        // write time (a NO_INVOICE confirm can attach an active claim to a
        // still-NOT_REQUIRED row between the read and this write).
        chargeCoverage: { none: { releasedAt: null } },
      },
      data: { status: "NOT_INVOICED" },
    });
  });

  it("leaves BASED_ON_AGE_TIER rows untouched (#2041 dominance)", async () => {
    const db = makeReconcileDb(untouchedSeedRow);
    const result = await reconcileSeasonSubscriptionForAssignment(db as never, {
      memberId: "m1",
      seasonYear: 2026,
      subscriptionBehavior: "BASED_ON_AGE_TIER",
    });

    expect(result).toEqual({ reconciled: false });
    expect(db.memberSubscription.findUnique).not.toHaveBeenCalled();
    expect(db.memberSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("leaves NOT_REQUIRED types untouched", async () => {
    const db = makeReconcileDb(untouchedSeedRow);
    const result = await reconcileSeasonSubscriptionForAssignment(db as never, {
      memberId: "m1",
      seasonYear: 2026,
      subscriptionBehavior: "NOT_REQUIRED",
    });

    expect(result).toEqual({ reconciled: false });
    expect(db.memberSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("never touches a row with a live Xero invoice", async () => {
    const db = makeReconcileDb({
      ...untouchedSeedRow,
      xeroInvoiceId: "INV-123",
    });
    const result = await reconcileSeasonSubscriptionForAssignment(db as never, {
      memberId: "m1",
      seasonYear: 2026,
      subscriptionBehavior: "REQUIRED",
    });

    expect(result).toEqual({ reconciled: false });
    expect(db.memberSubscription.updateMany).not.toHaveBeenCalled();
  });

  // #2179 regression: the guard used to be `chargeCoverage !== null`, which is
  // ALWAYS true against the real client (a to-many select returns [] when no
  // claim matches), so the reconcile branch was unreachable outside the stale
  // single-object test mocks. Exercise the guard BOTH ways with the real list
  // shape: an empty active-claim list reconciles; a present active claim
  // refuses.
  it("#2179: reconciles on an empty active-coverage list, refuses on a present active claim", async () => {
    const noActiveClaims = makeReconcileDb({ ...untouchedSeedRow, chargeCoverage: [] });
    expect(
      await reconcileSeasonSubscriptionForAssignment(noActiveClaims as never, {
        memberId: "m1",
        seasonYear: 2026,
        subscriptionBehavior: "REQUIRED",
      }),
    ).toEqual({ reconciled: true });
    expect(noActiveClaims.memberSubscription.updateMany).toHaveBeenCalledTimes(1);

    // e.g. a NO_INVOICE billing confirm: status stays NOT_REQUIRED but an
    // ACTIVE coverage claim exists — real billing state, never reconciled.
    const activeClaim = makeReconcileDb({
      ...untouchedSeedRow,
      chargeCoverage: [{ id: "cov-active" }],
    });
    expect(
      await reconcileSeasonSubscriptionForAssignment(activeClaim as never, {
        memberId: "m1",
        seasonYear: 2026,
        subscriptionBehavior: "REQUIRED",
      }),
    ).toEqual({ reconciled: false });
    expect(activeClaim.memberSubscription.updateMany).not.toHaveBeenCalled();
  });

  // The write-time WHERE re-asserts every read-phase guard, so a concurrent
  // writer that moved the row between the read and the write makes updateMany
  // match 0 rows. The lost race MUST surface as { reconciled: false } — the
  // count>0 mapping is the proof that a lost claim reports no side effect.
  it("reports { reconciled: false } when the write-time guard loses the race (updateMany matches 0 rows)", async () => {
    const db = makeReconcileDb(untouchedSeedRow, 0);
    const result = await reconcileSeasonSubscriptionForAssignment(db as never, {
      memberId: "m1",
      seasonYear: 2026,
      subscriptionBehavior: "REQUIRED",
    });

    expect(result).toEqual({ reconciled: false });
    expect(db.memberSubscription.updateMany).toHaveBeenCalledTimes(1);
  });

  it("never touches a manually marked-paid or charge-covered row", async () => {
    for (const guarded of [
      { ...untouchedSeedRow, manuallyMarkedPaidAt: new Date() },
      { ...untouchedSeedRow, chargeCoverage: [{ id: "cov-1" }] },
      { ...untouchedSeedRow, status: "PAID" },
    ]) {
      const db = makeReconcileDb(guarded);
      const result = await reconcileSeasonSubscriptionForAssignment(db as never, {
        memberId: "m1",
        seasonYear: 2026,
        subscriptionBehavior: "REQUIRED",
      });
      expect(result).toEqual({ reconciled: false });
      expect(db.memberSubscription.updateMany).not.toHaveBeenCalled();
    }
  });

  it("is a no-op when there is no row, and idempotent on re-run", async () => {
    const noRow = makeReconcileDb(null);
    expect(
      await reconcileSeasonSubscriptionForAssignment(noRow as never, {
        memberId: "m1",
        seasonYear: 2026,
        subscriptionBehavior: "REQUIRED",
      }),
    ).toEqual({ reconciled: false });
    expect(noRow.memberSubscription.updateMany).not.toHaveBeenCalled();

    // Second run after the row is already NOT_INVOICED: the guard excludes it,
    // so nothing changes.
    const alreadyReconciled = makeReconcileDb(
      { ...untouchedSeedRow, status: "NOT_INVOICED" },
      0,
    );
    expect(
      await reconcileSeasonSubscriptionForAssignment(alreadyReconciled as never, {
        memberId: "m1",
        seasonYear: 2026,
        subscriptionBehavior: "REQUIRED",
      }),
    ).toEqual({ reconciled: false });
    expect(alreadyReconciled.memberSubscription.updateMany).not.toHaveBeenCalled();
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
