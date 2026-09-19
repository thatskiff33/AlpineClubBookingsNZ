import { describe, expect, it } from "vitest";
import { matchesWhere, type WhereRow } from "./prisma-where";

// Fixtures sit relative to the frozen clock (2026-07-01T00:00Z): August is
// future, June is past, permanently.
const JULY = new Date("2026-07-10T00:00:00.000Z");
const AUGUST = new Date("2026-08-10T00:00:00.000Z");

function booking(overrides: WhereRow = {}): WhereRow {
  return {
    id: "b-1",
    status: "CONFIRMED",
    memberId: "m-1",
    deletedAt: null,
    checkIn: new Date(JULY),
    checkOut: new Date(AUGUST),
    notes: "Ruapehu weekend",
    finalPriceCents: 12000,
    member: { id: "m-1", active: true },
    originBookingRequest: null,
    guests: [
      { id: "g-1", memberId: "m-1" },
      { id: "g-2", memberId: null },
    ],
    ...overrides,
  };
}

describe("matchesWhere — scalar conditions", () => {
  it("matches every row on an empty or absent where, as Prisma does", () => {
    expect(matchesWhere(booking(), undefined)).toBe(true);
    expect(matchesWhere(booking(), null)).toBe(true);
    expect(matchesWhere(booking(), {})).toBe(true);
  });

  it("compares literals with strict equality and null as IS NULL", () => {
    expect(matchesWhere(booking(), { status: "CONFIRMED" })).toBe(true);
    expect(matchesWhere(booking(), { status: "PAID" })).toBe(false);
    expect(matchesWhere(booking(), { deletedAt: null })).toBe(true);
    expect(matchesWhere(booking({ deletedAt: JULY }), { deletedAt: null })).toBe(false);
    // An unset column (undefined) is NULL, as it would be on a real row.
    expect(matchesWhere({ deletedAt: undefined }, { deletedAt: null })).toBe(true);
  });

  it("compares dates by instant, not by object identity", () => {
    expect(matchesWhere(booking(), { checkIn: new Date(JULY) })).toBe(true);
    expect(matchesWhere(booking(), { checkIn: { equals: new Date(JULY) } })).toBe(true);
    expect(matchesWhere(booking(), { checkIn: { in: [new Date(JULY)] } })).toBe(true);
    expect(matchesWhere(booking(), { checkIn: AUGUST })).toBe(false);
  });

  it("applies equals / not / in / notIn, with nested not", () => {
    expect(matchesWhere(booking(), { status: { equals: "CONFIRMED" } })).toBe(true);
    expect(matchesWhere(booking(), { status: { not: "CONFIRMED" } })).toBe(false);
    expect(matchesWhere(booking(), { status: { not: "PAID" } })).toBe(true);
    expect(matchesWhere(booking(), { deletedAt: { not: null } })).toBe(false);
    expect(matchesWhere(booking({ deletedAt: JULY }), { deletedAt: { not: null } })).toBe(
      true,
    );
    expect(matchesWhere(booking(), { status: { in: ["PAID", "CONFIRMED"] } })).toBe(true);
    expect(matchesWhere(booking(), { status: { in: ["PAID"] } })).toBe(false);
    expect(matchesWhere(booking(), { status: { notIn: ["PAID"] } })).toBe(true);
    expect(matchesWhere(booking(), { status: { notIn: ["CONFIRMED"] } })).toBe(false);
    expect(matchesWhere(booking(), { status: { not: { in: ["CONFIRMED"] } } })).toBe(false);
  });

  it("applies the range operators over dates and numbers, and never over NULL", () => {
    expect(matchesWhere(booking(), { checkIn: { gte: JULY, lt: AUGUST } })).toBe(true);
    expect(matchesWhere(booking(), { checkIn: { gt: JULY } })).toBe(false);
    expect(matchesWhere(booking(), { checkOut: { lte: AUGUST } })).toBe(true);
    expect(matchesWhere(booking(), { checkOut: { lt: AUGUST } })).toBe(false);
    expect(matchesWhere(booking(), { finalPriceCents: { gte: 12000 } })).toBe(true);
    expect(matchesWhere(booking(), { finalPriceCents: { lt: 12000 } })).toBe(false);
    // SQL: NULL < anything is not true.
    expect(matchesWhere(booking({ checkOut: null }), { checkOut: { lt: AUGUST } })).toBe(
      false,
    );
    expect(matchesWhere(booking({ checkOut: null }), { checkOut: { gte: JULY } })).toBe(
      false,
    );
  });

  it("applies startsWith and contains to strings only", () => {
    expect(matchesWhere(booking(), { notes: { startsWith: "Ruapehu" } })).toBe(true);
    expect(matchesWhere(booking(), { notes: { startsWith: "weekend" } })).toBe(false);
    expect(matchesWhere(booking(), { notes: { contains: "weekend" } })).toBe(true);
    expect(matchesWhere(booking({ notes: null }), { notes: { contains: "" } })).toBe(false);
  });

  it("drops a condition of undefined, as Prisma does", () => {
    expect(matchesWhere(booking(), { status: undefined, memberId: "m-1" })).toBe(true);
    expect(matchesWhere(booking(), { status: { in: undefined } })).toBe(true);
  });
});

describe("matchesWhere — logical composition", () => {
  it("evaluates AND / OR / NOT with a list or a single clause", () => {
    expect(
      matchesWhere(booking(), { AND: [{ status: "CONFIRMED" }, { memberId: "m-1" }] }),
    ).toBe(true);
    expect(matchesWhere(booking(), { AND: { status: "PAID" } })).toBe(false);
    expect(matchesWhere(booking(), { OR: [{ status: "PAID" }, { memberId: "m-1" }] })).toBe(
      true,
    );
    expect(matchesWhere(booking(), { OR: [{ status: "PAID" }, { memberId: "m-2" }] })).toBe(
      false,
    );
    expect(matchesWhere(booking(), { OR: [] })).toBe(false);
    expect(matchesWhere(booking(), { NOT: { status: "PAID" } })).toBe(true);
    expect(matchesWhere(booking(), { NOT: [{ status: "PAID" }, { memberId: "m-1" }] })).toBe(
      false,
    );
  });

  it("nests composition inside composition", () => {
    const where = {
      AND: [{ OR: [{ checkIn: { lt: AUGUST } }, { checkOut: { gt: AUGUST } }] }],
      NOT: { deletedAt: { not: null } },
    };
    expect(matchesWhere(booking(), where)).toBe(true);
    expect(matchesWhere(booking({ deletedAt: JULY }), where)).toBe(false);
  });
});

describe("matchesWhere — relations", () => {
  it("reads to-one filters: is / isNot / the shorthand, with null as absence", () => {
    expect(matchesWhere(booking(), { member: { is: { active: true } } })).toBe(true);
    expect(matchesWhere(booking(), { member: { is: { active: false } } })).toBe(false);
    expect(matchesWhere(booking(), { member: { active: true } })).toBe(true);
    expect(matchesWhere(booking(), { member: { is: null } })).toBe(false);
    expect(matchesWhere(booking(), { member: { isNot: null } })).toBe(true);
    expect(matchesWhere(booking(), { originBookingRequest: { is: null } })).toBe(true);
    expect(matchesWhere(booking(), { originBookingRequest: { isNot: null } })).toBe(false);
    expect(matchesWhere(booking(), { originBookingRequest: { id: "r-1" } })).toBe(false);
    expect(matchesWhere(booking(), { member: { isNot: { active: true } } })).toBe(false);
  });

  it("reads to-many filters: some / none, with an absent list as empty", () => {
    expect(matchesWhere(booking(), { guests: { some: { memberId: "m-1" } } })).toBe(true);
    expect(matchesWhere(booking(), { guests: { some: { memberId: "m-9" } } })).toBe(false);
    expect(matchesWhere(booking(), { guests: { none: { memberId: "m-9" } } })).toBe(true);
    expect(matchesWhere(booking(), { guests: { none: { memberId: null } } })).toBe(false);
    expect(matchesWhere(booking({ guests: undefined }), { guests: { some: {} } })).toBe(
      false,
    );
  });

  it("evaluates a compound-unique key as its columns", () => {
    const row = { memberId: "m-1", seasonYear: 2026, status: "PAID" };
    expect(
      matchesWhere(row, { memberId_seasonYear: { memberId: "m-1", seasonYear: 2026 } }),
    ).toBe(true);
    expect(
      matchesWhere(row, { memberId_seasonYear: { memberId: "m-1", seasonYear: 2025 } }),
    ).toBe(false);
  });

  it("lets a store resolve relations through foreign keys and check nested rows its own way", () => {
    const members = [{ id: "m-1", active: false }];
    const seen: string[] = [];
    const options = {
      relation: (row: WhereRow, key: string) =>
        key === "owner"
          ? {
              related: members.find((m) => m.id === row.memberId) ?? null,
              matches: (related: WhereRow, where: WhereRow) => {
                seen.push(JSON.stringify(where));
                return matchesWhere(related, where);
              },
            }
          : undefined,
    };
    expect(matchesWhere({ memberId: "m-1" }, { owner: { is: { active: false } } }, options)).toBe(
      true,
    );
    expect(matchesWhere({ memberId: "m-2" }, { owner: { isNot: null } }, options)).toBe(false);
    expect(seen).toEqual(['{"active":false}']);
  });

  it("lets a store answer which keys are columns from its model spec", () => {
    const options = { column: (_row: WhereRow, key: string) => key === "notes" };
    // `notes` is a column by spec even though this row never carried it: NULL.
    expect(matchesWhere({ id: "x" }, { notes: null }, options)).toBe(true);
    // `id` is on the row but not in the spec, so filtering on it is an error.
    expect(() => matchesWhere({ id: "x" }, { id: "x" }, options)).toThrow(/"id"/);
  });
});

describe("matchesWhere — refuses what it does not model", () => {
  it("throws on a filter operator it does not implement, naming it", () => {
    expect(() => matchesWhere(booking(), { notes: { mode: "insensitive" } })).toThrow(
      /unsupported filter operator "mode" on notes/,
    );
    expect(() => matchesWhere(booking(), { notes: { endsWith: "x" } })).toThrow(
      /unsupported filter operator "endsWith" on notes/,
    );
    expect(() => matchesWhere(booking(), { guests: { every: {} } })).toThrow(
      /unsupported filter operator "every" on guests/,
    );
    expect(() => matchesWhere(booking(), { status: { equalz: "PAID" } })).toThrow(
      /unsupported filter operator "equalz" on status/,
    );
    // On a NULL column an unknown key could pass for the to-one shorthand on an
    // absent relation; an operator Prisma has is refused there too.
    expect(() => matchesWhere(booking(), { deletedAt: { endsWith: "x" } })).toThrow(
      /unsupported filter operator "endsWith" on deletedAt/,
    );
    // Nested inside `not`, where the scalar evaluator meets it directly.
    expect(() => matchesWhere(booking(), { status: { not: { equalz: "PAID" } } })).toThrow(
      /unsupported filter operator "equalz" on status/,
    );
    expect(() => matchesWhere(booking(), { status: { in: ["PAID"], is: null } })).toThrow(
      /mixing/,
    );
  });

  it("throws on a column the row does not carry, rather than reading it as NULL", () => {
    expect(() => matchesWhere(booking(), { lodgeId: "lodge-1" })).toThrow(
      /filter on "lodgeId", which is neither a column nor a relation/,
    );
    expect(() => matchesWhere(booking(), { lodgeId: { in: ["lodge-1"] } })).toThrow(
      /"lodgeId"/,
    );
  });

  it("throws on relation shapes Prisma does not spell that way", () => {
    expect(() => matchesWhere(booking(), { guests: { some: {}, id: "g" } })).toThrow(
      /mixing/,
    );
    expect(() => matchesWhere(booking(), { member: { some: {} } })).toThrow(/to-many/);
    expect(() => matchesWhere(booking(), { guests: { is: {} } })).toThrow(/to-one/);
  });

  it("names the caller when a label is given", () => {
    expect(() =>
      matchesWhere(booking(), { notes: { mode: "insensitive" } }, { label: "audit double" }),
    ).toThrow(/^audit double: unsupported/);
  });
});
