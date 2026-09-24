/**
 * The dietary/allergy field through its remaining writers and readers (#2941,
 * `INV-PRIV-022`): the member CSV import (route and preview), admin member
 * create, and the onboarding read. Each is driven with the club toggle ON and
 * OFF, and asserts both halves of the rule — the value is taken or shown where
 * approved, and ABSENT everywhere else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Fn = ReturnType<typeof vi.fn>;
const mocks = vi.hoisted(() => {
  const delegates = new Map<string, Record<string, unknown>>();
  const defaultFor = (method: string) =>
    method === "findMany"
      ? []
      : method === "count"
        ? 0
        : /Many$/.test(method)
          ? { count: 0 }
          : null;
  const delegate = (model: string) => {
    if (!delegates.has(model)) {
      const fns: Record<string, unknown> = {};
      delegates.set(
        model,
        new Proxy(fns, {
          get(target, method: string) {
            if (!(method in target)) {
              target[method] = vi.fn(async () => defaultFor(method));
            }
            return target[method];
          },
        }),
      );
    }
    return delegates.get(model)!;
  };
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "$transaction") return transaction;
        if (prop === "$executeRaw" || prop === "$queryRaw") return raw;
        if (prop === "then") return undefined;
        return delegate(prop);
      },
    },
  );
  const raw = vi.fn(async () => 0);
  const transaction = vi.fn(async (operation: unknown) =>
    Array.isArray(operation)
      ? Promise.all(operation)
      : (operation as (tx: unknown) => Promise<unknown>)(prisma),
  );
  return {
    prisma,
    delegate,
    reset: () => delegates.clear(),
    flags: {
      showTitle: false,
      showGender: false,
      showOccupation: false,
      showDietaryRequirements: false,
    },
    requireAdmin: vi.fn(),
    auth: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mocks.requireAdmin(...args),
  requireActiveSessionUser: vi.fn(async () => null),
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
}));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: vi.fn().mockReturnValue(null) }));
vi.mock("@/lib/email", () => ({ sendMemberSetupInviteEmail: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  createAuditLog: vi.fn(),
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({})),
  getAuditEmailDomain: vi.fn(() => null),
  logAudit: vi.fn(),
}));
vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed"),
  default: { hash: vi.fn().mockResolvedValue("hashed") },
}));

import { getAdminPermissionMatrix } from "@/lib/admin-permissions";
import { POST as importMembers } from "@/app/api/admin/members/import/route";
import { POST as createMember } from "@/app/api/admin/members/route";
import { GET as onboarding } from "@/app/api/member/onboarding/route";
import {
  buildMemberImportPreview,
  inferMemberImportColumnMapping,
  parseMemberImportCsv,
} from "@/lib/member-csv-import";
import { escapeCsvCell } from "@/lib/csv";
import { DIETARY_REQUIREMENTS_LABEL } from "@/lib/member-dietary-field";

const VALUE = "Severe peanut allergy";

/** The access role whose bundle gives exactly this membership level. */
const ROLE_FOR_MEMBERSHIP = {
  none: "ADMIN_CONTENT",
  view: "ADMIN_READONLY",
  edit: "ADMIN_MEMBERSHIP",
} as const;

/** The acting admin's DATABASE role, which is all the membership grant reads. */
function adminGuard(membership: "none" | "view" | "edit") {
  (mocks.delegate("member").findUnique as Fn).mockImplementation(
    async (args: { where?: { id?: string } }) =>
      args?.where?.id === "admin1"
        ? {
            active: true,
            canLogin: true,
            accessRoles: [{ role: ROLE_FOR_MEMBERSHIP[membership], roleDefinition: null }],
          }
        : null,
  );
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

function post(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function createdData(): Record<string, unknown>[] {
  return (mocks.delegate("member").create as Fn).mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reset();
  mocks.flags.showDietaryRequirements = false;
  mocks.requireAdmin.mockResolvedValue(adminGuard("edit"));
  (mocks.delegate("member").create as Fn).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "new-1",
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      canLogin: data.canLogin,
      role: data.role ?? "USER",
      accessRoles: [],
    }),
  );
});

describe("member CSV import route (INV-PRIV-022)", () => {
  const row = (dietaryRequirements: string) => ({
    firstName: "Aroha",
    lastName: "Member",
    email: "aroha@example.test",
    dietaryRequirements,
  });
  const importRows = (rows: unknown[]) =>
    importMembers(
      post("http://localhost/api/admin/members/import", { rows, sendInvites: false }),
    );

  it("ON with membership:edit imports the normalised value, formula guard undone", async () => {
    mocks.flags.showDietaryRequirements = true;
    const res = await importRows([row(`  '- no nuts  `)]);
    expect(res.status).toBe(200);
    expect(createdData()[0]?.dietaryRequirements).toBe("- no nuts");
  });

  it("OFF ignores the column entirely, even a value over the limit", async () => {
    const res = await importRows([row("x".repeat(600))]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toEqual([]);
    expect(createdData()[0]?.dietaryRequirements).toBeNull();
  });

  it("ON without membership edit access ignores the column", async () => {
    mocks.flags.showDietaryRequirements = true;
    mocks.requireAdmin.mockResolvedValue(adminGuard("view"));
    await importRows([row(VALUE)]);
    expect(createdData()[0]?.dietaryRequirements).toBeNull();
  });

  it("ON refuses 501 characters and creates nothing", async () => {
    mocks.flags.showDietaryRequirements = true;
    const res = await importRows([row("x".repeat(501))]);
    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].errors.join(" ")).toContain("500 characters");
    expect(createdData()).toEqual([]);
  });

  it("ON accepts an exported 500-character value that begins with a formula character", async () => {
    mocks.flags.showDietaryRequirements = true;
    const value = `-${"x".repeat(499)}`;
    // What the export writes (a leading apostrophe), read back by the parser.
    const exported = escapeCsvCell(value);
    expect(exported).toBe(`'${value}`);
    const res = await importRows([row(exported)]);
    expect((await res.json()).errors).toEqual([]);
    expect(createdData()[0]?.dietaryRequirements).toBe(value);
  });
});

describe("member CSV import preview (INV-PRIV-022)", () => {
  const csvText = (value: string) =>
    [
      `First Name,Last Name,Email,${DIETARY_REQUIREMENTS_LABEL}`,
      `Aroha,Member,aroha@example.test,${escapeCsvCell(value)}`,
    ].join("\r\n");

  function previewOf(value: string, importsDietaryRequirements: boolean) {
    const parsed = parseMemberImportCsv(csvText(value));
    if (!parsed.ok) throw new Error(parsed.error);
    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    return {
      mapping,
      preview: buildMemberImportPreview(parsed.data, mapping, "2026-07-01", {}, {
        importsDietaryRequirements,
      }),
    };
  }

  it("maps the export's own header back to the field (round trip)", () => {
    const { mapping, preview } = previewOf("=HYPERLINK(1), no nuts", true);
    expect(mapping.dietaryRequirements).toBe(3);
    expect(preview.rows[0]?.values.dietaryRequirements).toBe("=HYPERLINK(1), no nuts");
    expect(preview.hasErrors).toBe(false);
  });

  it("ON flags a value over 500 characters", () => {
    const { preview } = previewOf("x".repeat(501), true);
    expect(preview.rows[0]?.errors.join(" ")).toContain("500 characters");
  });

  it("OFF drops the column and does not judge its length", () => {
    const { preview } = previewOf("x".repeat(600), false);
    expect(preview.rows[0]?.values).not.toHaveProperty("dietaryRequirements");
    expect(preview.rows[0]?.errors).toEqual([]);
  });
});

describe("admin member create (INV-PRIV-022)", () => {
  const body = {
    firstName: "Aroha",
    lastName: "Member",
    email: "aroha@example.test",
    dietaryRequirements: `  ${VALUE}  `,
  };

  it("OFF stores nothing", async () => {
    const res = await createMember(post("http://localhost/api/admin/members", body));
    expect(res.status).toBeLessThan(300);
    expect(createdData()[0]).not.toHaveProperty("dietaryRequirements");
  });

  it("ON with membership:edit stores the normalised value", async () => {
    mocks.flags.showDietaryRequirements = true;
    const res = await createMember(post("http://localhost/api/admin/members", body));
    expect(res.status).toBeLessThan(300);
    expect(createdData()[0]?.dietaryRequirements).toBe(VALUE);
    // The created row handed back never carries the value.
    expect(JSON.stringify(await res.json())).not.toContain("peanut");
  });
});

describe("member onboarding read (INV-PRIV-022)", () => {
  function onboardingMember() {
    (mocks.delegate("member").findUnique as Fn).mockImplementation(
      async (args: { select?: Record<string, unknown> }) =>
        args?.select && "dietaryRequirements" in args.select && Object.keys(args.select).length === 1
          ? { dietaryRequirements: VALUE }
          : {
              id: "m1",
              firstName: "Aroha",
              lastName: "Member",
              email: "aroha@example.test",
              role: "USER",
              ageTier: "ADULT",
              active: true,
              canLogin: true,
              accessRoles: [],
              familyGroupMemberships: [],
            },
    );
  }

  it("OFF: no flag-true and no key in the profile", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "m1" } });
    onboardingMember();
    const res = await onboarding();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentMember.showDietaryRequirements).toBe(false);
    expect(body.currentMember.profile).not.toHaveProperty("dietaryRequirements");
    expect(JSON.stringify(body)).not.toContain("peanut");
  });

  it("ON: the member's own value only", async () => {
    mocks.flags.showDietaryRequirements = true;
    mocks.auth.mockResolvedValue({ user: { id: "m1" } });
    onboardingMember();
    const body = await (await onboarding()).json();
    expect(body.currentMember.showDietaryRequirements).toBe(true);
    expect(body.currentMember.profile.dietaryRequirements).toBe(VALUE);
  });
});
