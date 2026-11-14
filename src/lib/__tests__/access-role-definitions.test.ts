import { describe, expect, it, vi } from "vitest";
import {
  accessRoleAssignmentRowsFromTokens,
  accessRoleLabelForToken,
  buildAccessRoleOptions,
  buildFallbackAccessRoleOptions,
  buildUniqueAccessRoleKey,
  DEFAULT_ACCESS_ROLE_DEFINITIONS,
  ensureAccessRoleDefinitions,
  findUnknownAccessRoleTokens,
  previewMatrixForTokens,
  serializeAccessRoleDefinition,
  type AccessRoleDefinitionRecord,
} from "@/lib/access-role-definitions";

function definitionRecord(
  overrides: Partial<AccessRoleDefinitionRecord> = {},
): AccessRoleDefinitionRecord {
  return {
    id: "ardef_custom",
    key: "hut-warden",
    systemRole: null,
    label: "Hut Warden",
    description: "Lodge operations only.",
    overviewLevel: "NONE",
    bookingsLevel: "NONE",
    membershipLevel: "NONE",
    financeLevel: "NONE",
    lodgeLevel: "EDIT",
    contentLevel: "NONE",
    supportLevel: "NONE",
    requiresTwoFactor: null,
    sortOrder: 100,
    ...overrides,
  };
}

const treasurerRecord = definitionRecord({
  id: "ardef_finance_admin",
  key: "treasurer",
  systemRole: "FINANCE_ADMIN",
  label: "Treasurer",
  overviewLevel: "VIEW",
  bookingsLevel: "VIEW",
  membershipLevel: "VIEW",
  financeLevel: "EDIT",
  lodgeLevel: "NONE",
  sortOrder: 60,
});

describe("access-role definition serialization and options", () => {
  it("serializes level columns into an app-level permission matrix", () => {
    const summary = serializeAccessRoleDefinition(treasurerRecord);
    expect(summary.permissions).toEqual({
      overview: "view",
      bookings: "view",
      membership: "view",
      finance: "edit",
      lodge: "none",
      content: "none",
      support: "none",
    });
    expect(summary.systemRole).toBe("FINANCE_ADMIN");
  });

  it("builds options with enum tokens for seeded defaults and id tokens for custom roles", () => {
    const options = buildAccessRoleOptions([
      treasurerRecord,
      definitionRecord(),
    ]);
    const tokens = options.map((option) => option.token);

    expect(tokens.slice(0, 2)).toEqual(["USER", "ADMIN"]);
    expect(tokens.slice(-2)).toEqual(["LODGE", "ORG"]);
    expect(tokens).toContain("FINANCE_ADMIN");
    expect(tokens).toContain("ardef_custom");
    expect(tokens).not.toContain("ADMIN_READONLY");

    const custom = options.find((option) => option.token === "ardef_custom");
    expect(custom?.privileged).toBe(true);
    expect(custom?.system).toBe(false);
    const user = options.find((option) => option.token === "USER");
    expect(user?.privileged).toBe(false);
    expect(user?.system).toBe(true);
  });

  it("mirrors the seeded defaults in the static fallback options", () => {
    const tokens = buildFallbackAccessRoleOptions().map(
      (option) => option.token,
    );
    for (const definition of DEFAULT_ACCESS_ROLE_DEFINITIONS) {
      expect(tokens).toContain(definition.systemRole);
    }
    expect(tokens[0]).toBe("USER");
    expect(tokens[1]).toBe("ADMIN");
  });

  it("labels tokens from options, enum labels, or the raw token", () => {
    const options = buildAccessRoleOptions([definitionRecord()]);
    expect(accessRoleLabelForToken("ardef_custom", options)).toBe(
      "Hut Warden",
    );
    expect(accessRoleLabelForToken("ADMIN", options)).toBe("Full Admin");
    expect(accessRoleLabelForToken("ardef_unknown", options)).toBe(
      "ardef_unknown",
    );
  });

  it("merges preview matrices for the selected tokens only", () => {
    const options = buildAccessRoleOptions([
      treasurerRecord,
      definitionRecord(),
    ]);
    const matrix = previewMatrixForTokens(
      ["FINANCE_ADMIN", "ardef_custom"],
      options,
    );
    expect(matrix.finance).toBe("edit");
    expect(matrix.lodge).toBe("edit");
    expect(matrix.content).toBe("none");

    expect(previewMatrixForTokens([], options).finance).toBe("none");
  });
});

describe("token resolution for assignment rows", () => {
  const definitions = [treasurerRecord, definitionRecord()];

  it("links enum tokens to their seeded definition and keeps custom ids definition-only", () => {
    const rows = accessRoleAssignmentRowsFromTokens(
      ["USER", "FINANCE_ADMIN", "ardef_custom"],
      definitions,
    );
    expect(rows).toEqual([
      { role: "USER", roleDefinitionId: null, roleDefinition: null },
      {
        role: "FINANCE_ADMIN",
        roleDefinitionId: "ardef_finance_admin",
        roleDefinition: treasurerRecord,
      },
      {
        role: null,
        roleDefinitionId: "ardef_custom",
        roleDefinition: definitions[1],
      },
    ]);
  });

  it("drops unknown tokens and duplicates", () => {
    const rows = accessRoleAssignmentRowsFromTokens(
      ["USER", "USER", "ardef_missing"],
      definitions,
    );
    expect(rows).toHaveLength(1);
  });

  it("reports unknown tokens for validation", () => {
    expect(
      findUnknownAccessRoleTokens(
        ["USER", "ardef_custom", "ardef_missing"],
        definitions,
      ),
    ).toEqual(["ardef_missing"]);
  });
});

describe("ensureAccessRoleDefinitions", () => {
  it("upserts every seeded default without overwriting club edits and re-links enum rows", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findMany = vi.fn().mockResolvedValue([treasurerRecord]);

    await ensureAccessRoleDefinitions({
      accessRoleDefinition: { upsert, findMany },
      memberAccessRole: { updateMany },
    } as never);

    expect(upsert).toHaveBeenCalledTimes(
      DEFAULT_ACCESS_ROLE_DEFINITIONS.length,
    );
    for (const call of upsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
    expect(updateMany).toHaveBeenCalledWith({
      where: { role: "FINANCE_ADMIN", roleDefinitionId: null },
      data: { roleDefinitionId: "ardef_finance_admin" },
    });
  });
});

describe("buildUniqueAccessRoleKey", () => {
  it("slugs the label and suffixes on collision", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ id: "existing" })
      .mockResolvedValueOnce(null);

    const key = await buildUniqueAccessRoleKey(
      { accessRoleDefinition: { findUnique } } as never,
      "Hut Warden!",
    );
    expect(key).toBe("hut-warden-2");
    expect(findUnique).toHaveBeenCalledWith({
      where: { key: "hut-warden" },
      select: { id: true },
    });
  });
});
