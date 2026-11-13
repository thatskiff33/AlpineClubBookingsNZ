// #4988: the member CSV import's optional Membership Type and Family Key
// columns, as the browser preview judges them. The server repeats both
// refusals for itself (`member-import-type-family-route.test.ts`).
import { describe, expect, it } from "vitest";
import {
  buildMemberImportPreview,
  inferMemberImportColumnMapping,
  MEMBER_IMPORT_FIELD_DEFINITIONS,
  parseMemberImportCsv,
} from "@/lib/member-csv-import";
import {
  findOversizedMemberImportFamilyKeys,
  matchMemberImportMembershipType,
} from "@/lib/member-csv-import-type-family";
import { ADMIN_FAMILY_GROUP_MAX_MEMBERS } from "@/lib/admin-family-group-create";

const CLUB_TODAY = "2026-07-01";

function preview(csv: string, activeMembershipTypeNames?: string[]) {
  const parsed = parseMemberImportCsv(csv);
  if (!parsed.ok) throw new Error(parsed.error);
  return buildMemberImportPreview(
    parsed.data,
    inferMemberImportColumnMapping(parsed.data.headers),
    CLUB_TODAY,
    {},
    { activeMembershipTypeNames },
  );
}

describe("#4988 column aliases", () => {
  it("never gives two fields the same alias", () => {
    const owners = new Map<string, string>();
    for (const definition of MEMBER_IMPORT_FIELD_DEFINITIONS) {
      for (const alias of definition.aliases) {
        expect(owners.get(alias), `alias ${alias}`).toBeUndefined();
        owners.set(alias, definition.key);
      }
    }
  });

  it("keeps Family and Family Name on the last name, not the family key", () => {
    const mapping = inferMemberImportColumnMapping([
      "First Name",
      "Family",
      "Email",
      "Family Key",
    ]);
    expect(mapping.lastName).toBe(1);
    expect(mapping.familyKey).toBe(3);

    const familyName = inferMemberImportColumnMapping(["Family Name"]);
    expect(familyName.lastName).toBe(0);
    expect(familyName.familyKey).toBeNull();
  });

  it("maps Household and Membership Type, and leaves a bare Type unmapped", () => {
    const mapping = inferMemberImportColumnMapping([
      "Household",
      "Membership Type",
      "Type",
    ]);
    expect(mapping.familyKey).toBe(0);
    expect(mapping.membershipType).toBe(1);
    expect(Object.values(mapping)).not.toContain(2);
  });
});

describe("#4988 Membership Type column", () => {
  it("matches an active type by name, ignoring case and spacing", () => {
    const types = [
      { id: "t1", name: "Full Member" },
      { id: "t2", name: "Junior" },
    ];
    const match = matchMemberImportMembershipType("  full   MEMBER ", types);
    expect(match).toEqual({ ok: true, type: types[0] });
  });

  it("refuses an unknown name and an ambiguous one", () => {
    expect(
      matchMemberImportMembershipType("Gold", [{ name: "Full Member" }]),
    ).toEqual({
      ok: false,
      error: '"Gold" is not the name of an active membership type',
    });
    const ambiguous = matchMemberImportMembershipType("Family", [
      { name: "Family" },
      { name: "family" },
    ]);
    expect(ambiguous.ok).toBe(false);
  });

  it("blocks a row whose type is not an active type, naming the column", () => {
    const result = preview(
      "First Name,Last Name,Email,Membership Type\nAda,Lovelace,ada@example.com,Gold\nBo,Brown,bo@example.com,Junior",
      ["Full Member", "Junior"],
    );
    expect(result.hasErrors).toBe(true);
    expect(result.importRows).toEqual([]);
    expect(result.rows[0].errors).toEqual([
      'Membership Type (column Membership Type) "Gold" is not the name of an active membership type',
    ]);
    expect(result.rows[1].errors).toEqual([]);
    expect(result.rows[1].values.membershipType).toBe("Junior");
  });

  it("leaves the column to the server when the dialog has no type list", () => {
    const result = preview(
      "First Name,Last Name,Email,Membership Type\nAda,Lovelace,ada@example.com,Gold",
    );
    expect(result.hasErrors).toBe(false);
    expect(result.importRows[0].membershipType).toBe("Gold");
  });
});

describe("#4988 Family Key column", () => {
  it("carries the key on each row", () => {
    const result = preview(
      "First Name,Last Name,Email,Family Key\nAda,Lovelace,ada@example.com,F1\nBo,Lovelace,bo@example.com,F1",
    );
    expect(result.hasErrors).toBe(false);
    expect(result.importRows.map((row) => row.familyKey)).toEqual(["F1", "F1"]);
  });

  it("blocks every row of a key shared by more members than a family group holds", () => {
    const over = ADMIN_FAMILY_GROUP_MAX_MEMBERS + 1;
    const lines = Array.from(
      { length: over },
      (_, index) => `P${index},Big,p${index}@example.com, big `,
    );
    const result = preview(
      ["First Name,Last Name,Email,Family Key", ...lines, "Solo,Small,solo@example.com,small"].join("\n"),
    );
    expect(result.hasErrors).toBe(true);
    for (const row of result.rows.slice(0, over)) {
      expect(row.errors).toEqual([
        `Family Key (column Family Key) "big" is shared by ${over} rows; a family group holds at most ${ADMIN_FAMILY_GROUP_MAX_MEMBERS} members`,
      ]);
    }
    expect(result.rows[over].errors).toEqual([]);
  });

  it("allows a key shared by exactly the family group limit", () => {
    expect(
      findOversizedMemberImportFamilyKeys(
        Array.from({ length: ADMIN_FAMILY_GROUP_MAX_MEMBERS }, () => "F"),
      ).size,
    ).toBe(0);
  });
});
