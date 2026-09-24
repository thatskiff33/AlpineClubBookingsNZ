/**
 * The member dietary/allergy privacy boundary (#2941, `INV-PRIV-022`).
 *
 * `member-dietary-access-census.test.ts` proves no other file can SELECT the
 * column. This file proves what the one door does with it, and that the
 * surfaces the value must never reach drop it even when handed it directly:
 * the log/Sentry redactor, the audit sanitizer, the Xero contact payload and
 * the member merge's persisted row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  settingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique, findMany: mocks.memberFindMany },
    memberFieldsSettings: { findUnique: mocks.settingsFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DEFAULT_MEMBER_FIELDS_SETTINGS,
  MEMBER_FIELD_KEYS,
} from "@/config/member-fields";
import { getAdminPermissionMatrix } from "@/lib/admin-permissions";
import { sanitizeAuditMetadata } from "@/lib/audit";
import { escapeCsvCell, unescapeCsvFormulaGuard } from "@/lib/csv";
import {
  DIETARY_KEY_FRAGMENTS,
  DIETARY_REQUIREMENTS_MAX_LENGTH,
  isDietaryKeyName,
  normalizeImportedDietaryRequirements,
  dietaryRequirementsInputSchema,
  isDietaryRequirementsWithinLimit,
  normalizeDietaryRequirements,
} from "@/lib/member-dietary-field";
import {
  attachMergeDietaryRequirements,
  buildDietaryRequirementsPatch,
  dietaryRequirementsChanged,
  grantMembershipAdminDietaryAccess,
  grantMemberMergeDietaryAccess,
  grantSelfDataExportDietaryAccess,
  grantSelfDietaryAccess,
  isDietaryFieldEnabled,
  loadDietaryRequirementsForDisplay,
  readMemberDietaryRequirements,
  readMemberDietaryRequirementsByIds,
  redactDietaryMergeRow,
  redactDietaryValueForRecord,
} from "@/lib/member-dietary";
import {
  loadMemberFieldsFlags,
  normalizeMemberFieldsSettings,
} from "@/lib/member-fields-settings";
import { mergeMemberFields } from "@/lib/member-merge-field-rules";
import {
  redactSensitiveJson,
  redactSensitiveRecord,
} from "@/lib/redact-sensitive-json";
import { buildXeroContactUpdatePayload } from "@/lib/xero-contact-sync";

const VALUE = "Coeliac; severe peanut allergy (carries an EpiPen)";

/** The access role whose bundle gives exactly this membership level. */
const ROLE_FOR_MEMBERSHIP = {
  none: "ADMIN_CONTENT",
  view: "ADMIN_READONLY",
  edit: "ADMIN_MEMBERSHIP",
} as const;

/**
 * A requireAdmin-shaped result for "admin-1", whose DATABASE row (the only
 * thing the membership grant believes) holds the role for `membership`. The
 * session also carries a full-access matrix, which the grant must ignore.
 */
function adminUser(membership: "none" | "view" | "edit") {
  mocks.memberFindUnique.mockImplementation(
    async (args: { where: { id: string } }) =>
      args.where.id === "admin-1"
        ? {
            active: true,
            canLogin: true,
            accessRoles: [{ role: ROLE_FOR_MEMBERSHIP[membership], roleDefinition: null }],
          }
        : null,
  );
  return {
    ok: true as const,
    session: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: getAdminPermissionMatrix({ accessRoles: ["ADMIN"] }),
      },
    },
  };
}

const session = (id: string) => ({ user: { id } });

/** A merge db whose Full Admin count answers `fullAdmin` for the actor. */
function mergeDb(fullAdmin: boolean, rows: unknown[] = []) {
  return {
    member: {
      count: vi.fn().mockResolvedValue(fullAdmin ? 1 : 0),
      findMany: vi.fn().mockResolvedValue(rows),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the field's shape (INV-PRIV-022)", () => {
  it("normalises blank to null, trims, and folds CRLF", () => {
    expect(normalizeDietaryRequirements("   ")).toBeNull();
    expect(normalizeDietaryRequirements("")).toBeNull();
    expect(normalizeDietaryRequirements(null)).toBeNull();
    expect(normalizeDietaryRequirements(undefined)).toBeNull();
    expect(normalizeDietaryRequirements("  vegan\r\nno nuts  ")).toBe(
      "vegan\nno nuts",
    );
  });

  it("bounds the normalised value at 500 characters", () => {
    expect(DIETARY_REQUIREMENTS_MAX_LENGTH).toBe(500);
    expect(isDietaryRequirementsWithinLimit("x".repeat(500))).toBe(true);
    expect(isDietaryRequirementsWithinLimit("x".repeat(501))).toBe(false);
    // Surrounding whitespace a browser adds does not count.
    expect(isDietaryRequirementsWithinLimit(`  ${"x".repeat(500)}  `)).toBe(true);
    expect(dietaryRequirementsInputSchema.safeParse("x".repeat(501)).success).toBe(
      false,
    );
    expect(dietaryRequirementsInputSchema.safeParse(undefined).success).toBe(true);
    expect(dietaryRequirementsInputSchema.safeParse(null).success).toBe(true);
  });
});

describe("the toggle defaults OFF everywhere (INV-PRIV-022)", () => {
  it("is off in the defaults, on a missing row and on a partial row", () => {
    expect(MEMBER_FIELD_KEYS).toContain("showDietaryRequirements");
    expect(DEFAULT_MEMBER_FIELDS_SETTINGS.showDietaryRequirements).toBe(false);
    expect(normalizeMemberFieldsSettings(null).showDietaryRequirements).toBe(false);
    expect(
      normalizeMemberFieldsSettings({ showOccupation: true })
        .showDietaryRequirements,
    ).toBe(false);
  });

  it("is off when the settings read fails", async () => {
    mocks.settingsFindUnique.mockRejectedValue(new Error("relation missing"));
    expect((await loadMemberFieldsFlags()).showDietaryRequirements).toBe(false);
    expect(await isDietaryFieldEnabled()).toBe(false);
  });
});

describe("grants (INV-PRIV-022)", () => {
  it("a self grant reads only its own member", async () => {
    mocks.memberFindUnique.mockResolvedValue({ dietaryRequirements: VALUE });
    const grant = grantSelfDietaryAccess(session("m1"));

    await expect(readMemberDietaryRequirements(grant, "m1")).resolves.toBe(VALUE);
    expect(mocks.memberFindUnique).toHaveBeenCalledWith({
      where: { id: "m1" },
      select: { dietaryRequirements: true },
    });

    await expect(readMemberDietaryRequirements(grant, "m2")).rejects.toThrow(
      /covers only its own member/,
    );
    await expect(
      readMemberDietaryRequirements(grantSelfDataExportDietaryAccess(session("m1")), "m2"),
    ).rejects.toThrow(/covers only its own member/);
  });

  it("a forged grant object is refused", async () => {
    const forged = {
      purpose: "membership-admin",
      subjectMemberId: null,
      actorMemberId: "x",
    } as unknown as Parameters<typeof readMemberDietaryRequirements>[0];
    await expect(readMemberDietaryRequirements(forged, "m1")).rejects.toThrow(
      /without an access grant/,
    );
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
  });

  it("a copy of a grant carries no authority, even with its scope widened", async () => {
    mocks.memberFindUnique.mockResolvedValue({ dietaryRequirements: VALUE });
    mocks.memberFindMany.mockResolvedValue([{ id: "m2", dietaryRequirements: VALUE }]);
    const self = grantSelfDietaryAccess(session("m1"));
    const merge = await grantMemberMergeDietaryAccess(mergeDb(true) as never, {
      actorMemberId: "a",
      masterId: "m1",
      loserId: "m2",
    });
    for (const copy of [
      { ...self },
      { ...self, memberIds: null },
      { ...merge },
      { ...merge, memberIds: null },
      Object.assign(Object.create(Object.getPrototypeOf(self)), self),
    ] as unknown as Parameters<typeof readMemberDietaryRequirements>[0][]) {
      await expect(readMemberDietaryRequirements(copy, "m2")).rejects.toThrow(
        /without an access grant/,
      );
      await expect(readMemberDietaryRequirementsByIds(copy, ["m2"])).rejects.toThrow(
        /membership administration or merge grant/,
      );
    }
    // The originals still work within their own scope.
    await expect(readMemberDietaryRequirements(self, "m1")).resolves.toBe(VALUE);
    expect(Object.keys(self)).toEqual([]);
  });

  it("membership administration needs membership access at the level asked, from the DATABASE", async () => {
    await expect(
      grantMembershipAdminDietaryAccess(adminUser("none"), "view"),
    ).resolves.toBeNull();
    await expect(
      grantMembershipAdminDietaryAccess(adminUser("view"), "edit"),
    ).resolves.toBeNull();
    await expect(
      grantMembershipAdminDietaryAccess(adminUser("view"), "view"),
    ).resolves.not.toBeNull();
    await expect(
      grantMembershipAdminDietaryAccess(adminUser("edit"), "edit"),
    ).resolves.not.toBeNull();
    // Neither a JWT-carried nor a literal matrix makes a grant: the actor's
    // row is what counts, and an actor with no row gets nothing.
    mocks.memberFindUnique.mockResolvedValue(null);
    await expect(
      grantMembershipAdminDietaryAccess(
        {
          ok: true,
          session: {
            user: {
              id: "forged",
              adminPermissionMatrix: { membership: "edit" },
            } as { id: string },
          },
        },
        "view",
      ),
    ).resolves.toBeNull();
    // An inactive actor gets nothing even with the right role.
    mocks.memberFindUnique.mockResolvedValue({
      active: false,
      canLogin: true,
      accessRoles: [{ role: "ADMIN", roleDefinition: null }],
    });
    await expect(
      grantMembershipAdminDietaryAccess(
        { ok: true, session: { user: { id: "admin-1" } } },
        "view",
      ),
    ).resolves.toBeNull();
  });

  it("bulk reads need membership administration, and select only the column", async () => {
    mocks.memberFindMany.mockResolvedValue([
      { id: "m1", dietaryRequirements: VALUE },
      { id: "m2", dietaryRequirements: null },
    ]);
    await expect(
      readMemberDietaryRequirementsByIds(grantSelfDietaryAccess(session("m1")), ["m1"]),
    ).rejects.toThrow(/membership administration or merge grant/);

    const values = await readMemberDietaryRequirementsByIds(
      (await grantMembershipAdminDietaryAccess(adminUser("view"), "view"))!,
      ["m1", "m2", "m1"],
    );
    expect(values.get("m1")).toBe(VALUE);
    expect(values.get("m2")).toBeNull();
    expect(mocks.memberFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["m1", "m2"] } },
      select: { id: true, dietaryRequirements: true },
    });
  });

  it("a merge grant is verified against the database and scoped to its two members", async () => {
    await expect(
      grantMemberMergeDietaryAccess(mergeDb(false) as never, {
        actorMemberId: "a",
        masterId: "m1",
        loserId: "m2",
      }),
    ).resolves.toBeNull();
    await expect(
      grantMemberMergeDietaryAccess(mergeDb(true) as never, {
        actorMemberId: "a",
        masterId: "m1",
        loserId: "m1",
      }),
    ).resolves.toBeNull();

    const grant = await grantMemberMergeDietaryAccess(mergeDb(true) as never, {
      actorMemberId: "a",
      masterId: "m1",
      loserId: "m2",
    });
    expect(grant).not.toBeNull();
    await expect(
      readMemberDietaryRequirementsByIds(grant!, ["m1", "m3"]),
    ).rejects.toThrow(/only its two participants/);
    await expect(readMemberDietaryRequirements(grant!, "m3")).rejects.toThrow(
      /only its two participants/,
    );
  });

  it("display while OFF reads nothing and returns no value", async () => {
    const shown = await loadDietaryRequirementsForDisplay(
      grantSelfDietaryAccess(session("m1")),
      "m1",
      { enabled: false },
    );
    expect(shown).toEqual({ enabled: false });
    expect("value" in shown).toBe(false);
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
  });
});

describe("writers (INV-PRIV-022)", () => {
  it("OFF, or a value not sent, produces no patch so the stored value survives", () => {
    expect(buildDietaryRequirementsPatch({ enabled: false, value: VALUE })).toEqual({});
    expect(buildDietaryRequirementsPatch({ enabled: false, value: "" })).toEqual({});
    expect(buildDietaryRequirementsPatch({ enabled: true, value: undefined })).toEqual(
      {},
    );
  });

  it("ON writes the normalised value, and blank clears it", () => {
    expect(
      buildDietaryRequirementsPatch({ enabled: true, value: `  ${VALUE}  ` }),
    ).toEqual({ dietaryRequirements: VALUE });
    expect(buildDietaryRequirementsPatch({ enabled: true, value: "   " })).toEqual({
      dietaryRequirements: null,
    });
  });

  it("reports whether the value changed without ever returning it", () => {
    expect(dietaryRequirementsChanged(null, {})).toBe(false);
    expect(dietaryRequirementsChanged(VALUE, { dietaryRequirements: VALUE })).toBe(
      false,
    );
    expect(dietaryRequirementsChanged(null, { dietaryRequirements: VALUE })).toBe(
      true,
    );
    expect(dietaryRequirementsChanged(VALUE, { dietaryRequirements: null })).toBe(
      true,
    );
  });
});

describe("member merge keeps the loser's value only when the master has none", () => {
  const base = { id: "x", firstName: "A", lastName: "B" };

  it("fills a blank master from the loser", () => {
    const { patch, diff } = mergeMemberFields(
      { ...base, dietaryRequirements: null },
      { ...base, dietaryRequirements: VALUE },
    );
    expect(patch.dietaryRequirements).toBe(VALUE);
    expect(diff.find((row) => row.field === "dietaryRequirements")?.source).toBe(
      "loser",
    );
  });

  it("master wins when both hold a value", () => {
    const { patch, diff } = mergeMemberFields(
      { ...base, dietaryRequirements: "Vegetarian" },
      { ...base, dietaryRequirements: VALUE },
    );
    expect(patch.dietaryRequirements).toBeUndefined();
    expect(diff.find((row) => row.field === "dietaryRequirements")?.result).toBe(
      "Vegetarian",
    );
  });

  it("the engine attaches the loser's stored value through the door, so it survives", async () => {
    const db = mergeDb(true, [
      { id: "master", dietaryRequirements: null },
      { id: "loser", dietaryRequirements: VALUE },
    ]) as never;
    const [masterRow, loserRow] = await attachMergeDietaryRequirements(
      db,
      "a",
      { ...base, id: "master" },
      { ...base, id: "loser" },
    );
    expect(
      mergeMemberFields(masterRow, loserRow).patch.dietaryRequirements,
    ).toBe(VALUE);
  });

  it("reads nothing for an actor the database does not confirm as Full Admin", async () => {
    const db = mergeDb(false);
    const [masterRow, loserRow] = await attachMergeDietaryRequirements(
      db as never,
      "a",
      { ...base, id: "master" },
      { ...base, id: "loser" },
    );
    expect(db.member.count).toHaveBeenCalled();
    expect(db.member.findMany).not.toHaveBeenCalled();
    expect("dietaryRequirements" in masterRow).toBe(false);
    expect("dietaryRequirements" in loserRow).toBe(false);
  });

  it("the merge audit row keeps the field and source but not the values", () => {
    const row = redactDietaryMergeRow({
      field: "dietaryRequirements",
      master: null,
      loser: VALUE,
      result: VALUE,
      source: "loser",
    });
    expect(row).toEqual({
      field: "dietaryRequirements",
      master: null,
      loser: "[REDACTED]",
      result: "[REDACTED]",
      source: "loser",
    });
    const other = { field: "occupation", master: "A", loser: "B", result: "A" };
    expect(redactDietaryMergeRow(other)).toBe(other);
  });

  it("a persisted record says only whether a value is recorded", () => {
    expect(redactDietaryValueForRecord(VALUE)).toBe("[REDACTED]");
    expect(redactDietaryValueForRecord("  ")).toBeNull();
    expect(redactDietaryValueForRecord(null)).toBeNull();
  });
});

describe("negative egress: surfaces handed the value still drop it (INV-PRIV-022)", () => {
  it("the log/Sentry redactor strips dietary and allergy keys", () => {
    const payload = {
      member: { id: "m1", dietaryRequirements: VALUE },
      guestDietary: VALUE,
      allergies: VALUE,
      allergyNotes: VALUE,
    };
    for (const redacted of [
      redactSensitiveJson(payload),
      redactSensitiveRecord(payload),
    ]) {
      const text = JSON.stringify(redacted);
      expect(text).not.toContain("peanut");
      expect(text).toContain('"id":"m1"');
    }
  });

  it("the audit sanitizer redacts a value under a dietary key but keeps change evidence", () => {
    const sanitized = sanitizeAuditMetadata({
      changedFields: ["dietaryRequirements"],
      fieldGroups: { dietaryRequirements: true },
      dietaryRequirementsSet: true,
      dietaryRequirements: VALUE,
      before: { allergies: VALUE },
    }) as Record<string, unknown>;
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain("peanut");
    expect(sanitized.changedFields).toEqual(["dietaryRequirements"]);
    expect(sanitized.fieldGroups).toEqual({ dietaryRequirements: true });
    expect(sanitized.dietaryRequirementsSet).toBe(true);
    expect(sanitized.dietaryRequirements).toBe("[REDACTED]");
  });

  it("the Xero contact payload never carries it, even from a row that does", () => {
    const payload = buildXeroContactUpdatePayload({
      firstName: "Aroha",
      lastName: "Member",
      email: "aroha@example.test",
      dietaryRequirements: VALUE,
    } as unknown as Parameters<typeof buildXeroContactUpdatePayload>[0]);
    expect(JSON.stringify(payload)).not.toContain("peanut");
    expect(Object.keys(payload)).not.toContain("dietaryRequirements");
  });
});

describe("one spelling of the dietary key, read by both redactors (INV-SSOT, INV-PRIV-022)", () => {
  it("every fragment is redacted by the log redactor AND the audit sanitizer", () => {
    expect(DIETARY_KEY_FRAGMENTS.length).toBeGreaterThan(0);
    for (const fragment of DIETARY_KEY_FRAGMENTS) {
      const key = `guest_${fragment}_notes`;
      expect(isDietaryKeyName(key), key).toBe(true);
      expect(JSON.stringify(redactSensitiveJson({ [key]: VALUE })), key).not.toContain(
        "peanut",
      );
      expect(
        JSON.stringify(sanitizeAuditMetadata({ [key]: VALUE })),
        key,
      ).not.toContain("peanut");
    }
  });

  it("a key naming neither fragment is left to each redactor's own rules", () => {
    expect(isDietaryKeyName("diet")).toBe(false);
    expect(isDietaryKeyName("menuNotes")).toBe(false);
    expect(
      (sanitizeAuditMetadata({ menuNotes: "soup" }) as Record<string, unknown>)
        .menuNotes,
    ).toBe("soup");
  });
});

describe("the CSV formula guard round-trips for the dietary column", () => {
  it("undoes exactly the guard the export adds, and nothing else", () => {
    for (const value of ["- no nuts", "=1+1", "+64 allergy line", "@home"]) {
      const exported = escapeCsvCell(value);
      expect(exported.startsWith("'")).toBe(true);
      expect(normalizeImportedDietaryRequirements(exported)).toBe(value);
    }
    expect(unescapeCsvFormulaGuard("'tis fine")).toBe("'tis fine");
    expect(unescapeCsvFormulaGuard("''=x")).toBe("''=x");
  });
});
