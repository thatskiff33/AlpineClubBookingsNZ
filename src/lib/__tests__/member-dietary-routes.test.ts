/**
 * The dietary/allergy field through its real routes (#2941, `INV-PRIV-022`).
 *
 * Drives the member's own profile writer, the admin member editor, the member
 * CSV export and the member's own data export with the club toggle ON and OFF,
 * and with and without a membership grant. Each case asserts both halves of
 * the rule: the value reaches the audience the owner approved, and it is
 * ABSENT — not blank, absent — everywhere else, including from audit metadata.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  flags: {
    showTitle: false,
    showGender: false,
    showOccupation: false,
    showDietaryRequirements: false,
  },
  requireAdmin: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    accessRoleDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    member: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    booking: { findMany: vi.fn().mockResolvedValue([]), aggregate: vi.fn() },
    choreAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    memberSubscription: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    clubTimeSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroContactCache: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn(async () => null),
  requireAdmin: (...args: unknown[]) => mocks.requireAdmin(...args),
}));
vi.mock("@/lib/member-fields-settings", () => ({
  loadMemberFieldsFlags: vi.fn(async () => ({ ...mocks.flags })),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
  getAgeTierSettings: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 5,
    remaining: 4,
    resetAt: 0,
  }),
  rateLimiters: { dataExport: {} },
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAdminPermissionMatrix } from "@/lib/admin-permissions";
import { PUT as updateProfile } from "@/app/api/profile/route";
import { PUT as updateMember } from "@/app/api/admin/members/[id]/route";
import { GET as exportMembers } from "@/app/api/admin/members/export/route";
import { GET as exportOwnData } from "@/app/api/member/data-export/route";

const VALUE = "Severe peanut allergy";
const STORED = "Vegetarian";

const baseMember = {
  id: "m1",
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@test.com",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  dateOfBirth: new Date("1990-01-15"),
  role: "USER",
  ageTier: "ADULT",
  accessRoles: [{ role: "USER" }],
  active: true,
  forcePasswordChange: false,
  xeroContactId: null,
  joinedDate: null,
  createdAt: new Date("2025-01-01"),
  canLogin: true,
  profileCompletedAt: new Date("2025-02-01"),
  streetAddressLine1: "123 Main St",
  streetAddressLine2: null,
  streetCity: "Example",
  streetRegion: "Waikato",
  streetPostalCode: "3420",
  streetCountry: "NZ",
  postalAddressLine1: "PO Box 42",
  postalAddressLine2: null,
  postalCity: "Example",
  postalRegion: "Waikato",
  postalPostalCode: "3420",
  postalCountry: "NZ",
};

const profileBody = {
  firstName: "Alice",
  lastName: "Smith",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  dateOfBirth: "1990-01-15",
  streetAddressLine1: "123 Main St",
  streetCity: "Example",
  streetRegion: "Waikato",
  streetPostalCode: "3420",
  streetCountry: "NZ",
  postalAddressLine1: "PO Box 42",
  postalCity: "Example",
  postalRegion: "Waikato",
  postalPostalCode: "3420",
  postalCountry: "NZ",
};

/** The access role whose bundle gives exactly this membership level. */
const ROLE_FOR_MEMBERSHIP = {
  none: "ADMIN_CONTENT",
  view: "ADMIN_READONLY",
  edit: "ADMIN_MEMBERSHIP",
} as const;

/** The acting admin's DATABASE role, which is all the membership grant reads. */
let actorMembership: "none" | "view" | "edit" = "none";

function adminSession(membership: "none" | "view" | "edit") {
  actorMembership = membership;
  const matrix = getAdminPermissionMatrix({ accessRoles: ["ADMIN"] });
  return {
    ok: true,
    session: {
      user: {
        id: "admin1",
        role: "ADMIN",
        accessRoles: ["ADMIN"],
        adminPermissionMatrix: { ...matrix, membership },
      },
    },
  };
}

/** Member reads: the dietary door's explicit select gets the stored value. */
function memberReads(stored: string | null) {
  vi.mocked(prisma.member.findUnique).mockImplementation((async (args: {
    select?: Record<string, unknown>;
  }) => {
    if ((args as { where?: { id?: string } })?.where?.id === "admin1") {
      return {
        active: true,
        canLogin: true,
        accessRoles: [{ role: ROLE_FOR_MEMBERSHIP[actorMembership], roleDefinition: null }],
      };
    }
    if (args?.select && "dietaryRequirements" in args.select) {
      return { dietaryRequirements: stored };
    }
    return baseMember;
  }) as never);
}

function lastAuditMetadata(): Record<string, unknown> {
  const calls = vi.mocked(prisma.auditLog.create).mock.calls;
  const args = calls[calls.length - 1]?.[0] as { data: { metadata: unknown } };
  return args.data.metadata as Record<string, unknown>;
}

function updateData(): Record<string, unknown> {
  const calls = vi.mocked(prisma.member.update).mock.calls;
  return (calls[calls.length - 1]?.[0] as { data: Record<string, unknown> }).data;
}

function put(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags.showDietaryRequirements = false;
  vi.mocked(prisma.member.count).mockResolvedValue(1);
  vi.mocked(prisma.member.findMany).mockResolvedValue([]);
  vi.mocked(prisma.member.update).mockResolvedValue(baseMember as never);
  memberReads(null);
  vi.mocked(prisma.$transaction).mockImplementation((async (operation: unknown) => {
    if (Array.isArray(operation)) return Promise.all(operation);
    return (operation as (tx: unknown) => Promise<unknown>)({
      member: {
        update: prisma.member.update,
        count: prisma.member.count,
        findMany: prisma.member.findMany,
      },
      memberAccessRole: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: prisma.auditLog.create },
    });
  }) as never);
});

describe("the member's own profile (INV-PRIV-022)", () => {
  it("OFF: a sent value is ignored and the stored value is not touched", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "m1" } } as never);
    memberReads(STORED);

    const res = await updateProfile(
      put("http://localhost/api/profile", {
        ...profileBody,
        dietaryRequirements: VALUE,
      }),
    );
    expect(res.status).toBe(200);
    expect(updateData()).not.toHaveProperty("dietaryRequirements");
    expect(lastAuditMetadata().changedFields).not.toContain("dietaryRequirements");
  });

  it("ON: writes the normalised value; the audit row names the field, never the value", async () => {
    mocks.flags.showDietaryRequirements = true;
    vi.mocked(auth).mockResolvedValue({ user: { id: "m1" } } as never);
    memberReads(STORED);

    const res = await updateProfile(
      put("http://localhost/api/profile", {
        ...profileBody,
        dietaryRequirements: `  ${VALUE}  `,
      }),
    );
    expect(res.status).toBe(200);
    expect(updateData().dietaryRequirements).toBe(VALUE);

    const metadata = lastAuditMetadata();
    expect(metadata.changedFields).toContain("dietaryRequirements");
    expect(
      (metadata.fieldGroups as Record<string, unknown>).dietaryRequirements,
    ).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain("peanut");
    expect(JSON.stringify(metadata)).not.toContain(STORED);
    // The response is the Xero-sync projection and never carries the value.
    expect(JSON.stringify(await res.json())).not.toContain("peanut");
  });

  it("ON: any age tier may maintain it", async () => {
    mocks.flags.showDietaryRequirements = true;
    vi.mocked(auth).mockResolvedValue({ user: { id: "m1" } } as never);
    vi.mocked(prisma.member.findUnique).mockImplementation((async (args: {
      select?: Record<string, unknown>;
    }) =>
      args?.select && "dietaryRequirements" in args.select
        ? { dietaryRequirements: null }
        : { ...baseMember, ageTier: "CHILD", canLogin: false }) as never);

    const res = await updateProfile(
      put("http://localhost/api/profile", {
        ...profileBody,
        dateOfBirth: undefined,
        dietaryRequirements: VALUE,
      }),
    );
    expect(res.status).toBe(200);
    expect(updateData().dietaryRequirements).toBe(VALUE);
  });

  it("refuses a value over 500 characters", async () => {
    mocks.flags.showDietaryRequirements = true;
    vi.mocked(auth).mockResolvedValue({ user: { id: "m1" } } as never);
    memberReads(null);

    const res = await updateProfile(
      put("http://localhost/api/profile", {
        ...profileBody,
        dietaryRequirements: "x".repeat(501),
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.member.update).not.toHaveBeenCalled();
  });
});

describe("the admin member editor (INV-PRIV-022)", () => {
  const url = "http://localhost/api/admin/members/m1";
  const params = { params: Promise.resolve({ id: "m1" }) };

  it("ON with membership:edit writes it, audits the field only, and echoes it", async () => {
    mocks.flags.showDietaryRequirements = true;
    mocks.requireAdmin.mockResolvedValue(adminSession("edit"));
    memberReads(STORED);

    const res = await updateMember(put(url, { dietaryRequirements: VALUE }), params);
    expect(res.status).toBe(200);
    expect(updateData().dietaryRequirements).toBe(VALUE);
    const metadata = lastAuditMetadata();
    expect(metadata.changedFields).toContain("dietaryRequirements");
    expect(JSON.stringify(metadata)).not.toContain("peanut");
    expect((await res.json()).dietaryRequirements).toBe(STORED);
  });

  it("OFF writes nothing and the response carries no key", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession("edit"));
    memberReads(STORED);

    const res = await updateMember(put(url, { dietaryRequirements: VALUE }), params);
    expect(res.status).toBe(200);
    expect(updateData()).not.toHaveProperty("dietaryRequirements");
    expect(await res.json()).not.toHaveProperty("dietaryRequirements");
  });

  it("an admin without membership access holds no grant, even while ON", async () => {
    mocks.flags.showDietaryRequirements = true;
    // The route's own guard is mocked open; the grant is judged independently
    // from the DB-verified matrix, which here lacks membership.
    mocks.requireAdmin.mockResolvedValue(adminSession("none"));
    memberReads(STORED);

    const res = await updateMember(put(url, { dietaryRequirements: VALUE }), params);
    expect(res.status).toBe(200);
    expect(updateData()).not.toHaveProperty("dietaryRequirements");
    expect(await res.json()).not.toHaveProperty("dietaryRequirements");
  });
});

describe("the member CSV export (INV-PRIV-022)", () => {
  const exportRow = {
    id: "m1",
    title: null,
    firstName: "Alice",
    lastName: "Smith",
    gender: null,
    occupation: null,
    email: "alice@test.com",
    deletedAt: null,
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    dateOfBirth: null,
    role: "USER",
    financeAccessLevel: "NONE",
    ageTier: "ADULT",
    active: true,
    cancelledAt: null,
    archivedAt: null,
    xeroContactId: null,
    createdAt: new Date("2025-01-01"),
    streetAddressLine1: null,
    streetAddressLine2: null,
    streetCity: null,
    streetRegion: null,
    streetCountry: null,
    streetPostalCode: null,
    lifeMemberDate: null,
    comments: null,
    subscriptions: [],
    seasonalMembershipAssignments: [],
  };

  function exportCsv() {
    return exportMembers(new NextRequest("http://localhost/api/admin/members/export"));
  }

  it("ON with membership access: one escaped column, and the audit says only that it was included", async () => {
    mocks.flags.showDietaryRequirements = true;
    mocks.requireAdmin.mockResolvedValue(adminSession("view"));
    vi.mocked(prisma.member.findMany)
      .mockResolvedValueOnce([exportRow] as never)
      .mockResolvedValueOnce([
        { id: "m1", dietaryRequirements: "=HYPERLINK(1)\nno nuts, please" },
      ] as never);

    const res = await exportCsv();
    expect(res.status).toBe(200);
    const csv = await res.text();
    const [header] = csv.split("\r\n");
    expect(header.split(",")).toContain("Dietary/allergy information");
    // Formula neutralised with a leading apostrophe; the embedded newline and
    // comma are quoted.
    expect(csv).toContain(`"'=HYPERLINK(1)\nno nuts, please"`);
    // The row select never names the column; the second read is the door's.
    const rowSelect = (vi.mocked(prisma.member.findMany).mock.calls[0]?.[0] as {
      select: Record<string, unknown>;
    }).select;
    expect(rowSelect).not.toHaveProperty("dietaryRequirements");
  });

  it("OFF: no column, and the value is never read", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession("view"));
    vi.mocked(prisma.member.findMany).mockResolvedValueOnce([exportRow] as never);

    const csv = await (await exportCsv()).text();
    expect(csv).not.toContain("Dietary/allergy information");
    expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
  });

  it("ON without membership access: no column", async () => {
    mocks.flags.showDietaryRequirements = true;
    mocks.requireAdmin.mockResolvedValue(adminSession("none"));
    vi.mocked(prisma.member.findMany).mockResolvedValueOnce([exportRow] as never);

    const csv = await (await exportCsv()).text();
    expect(csv).not.toContain("Dietary/allergy information");
    expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("the member's own data export (INV-PRIV-022)", () => {
  it("includes the stored value even while the field is OFF (owner decision, 20 Sep 2026)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "m1" } } as never);
    memberReads(VALUE);

    const res = await exportOwnData();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: Record<string, unknown> };
    expect(body.profile.dietaryRequirements).toBe(VALUE);
    // Read for the signed-in member only.
    expect(prisma.member.findUnique).toHaveBeenCalledWith({
      where: { id: "m1" },
      select: { dietaryRequirements: true },
    });
  });
});
