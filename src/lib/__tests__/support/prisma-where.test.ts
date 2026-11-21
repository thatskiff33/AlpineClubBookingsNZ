import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
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

  it("reads startsWith and contains as the unescaped LIKE Prisma sends (#4165)", () => {
    const action = (value: string) => booking({ notes: value });
    // A bare `_` is any one character and `%` any run, as PostgreSQL reads them.
    expect(matchesWhere(action("xero.contact.synced"), { notes: { startsWith: "xero_" } })).toBe(true);
    expect(matchesWhere(action("memberXlifecycle.delete_x"), { notes: { startsWith: "member_lifecycle.delete" } })).toBe(true);
    expect(matchesWhere(action("a-long-b"), { notes: { startsWith: "a%b" } })).toBe(true);
    expect(matchesWhere(action("xDATAXEXPORTx"), { notes: { contains: "DATA_EXPORT" } })).toBe(true);
    // A `.` and the regex metacharacters are literal.
    expect(matchesWhere(action("memberXprofile"), { notes: { startsWith: "member." } })).toBe(false);
    expect(matchesWhere(action("a(b)+c"), { notes: { startsWith: "a(b)+" } })).toBe(true);
    // A backslash escapes the next character, which is how `exactPrefix` asks for a literal.
    expect(matchesWhere(action("xero.contact.synced"), { notes: { startsWith: "xero\\_" } })).toBe(false);
    expect(matchesWhere(action("xero_account_mappings_updated"), { notes: { startsWith: "xero\\_" } })).toBe(true);
    expect(matchesWhere(action("MEMBERSHIP_APPLICATION_APPROVED"), { notes: { startsWith: "MEMBERSHIP\\_APPLICATION" } })).toBe(true);
    expect(matchesWhere(action("50%_off\\x"), { notes: { startsWith: "50\\%\\_off\\\\" } })).toBe(true);
    expect(matchesWhere(action("50%Xoff\\x"), { notes: { startsWith: "50\\%\\_off\\\\" } })).toBe(false);
    // Case-sensitive, as LIKE is.
    expect(matchesWhere(action("XERO_PUSH"), { notes: { startsWith: "xero\\_" } })).toBe(false);
    // Prisma appends `%`, so a trailing backslash escapes it: `startsWith: "a\\"`
    // is `LIKE 'a\%'` (exactly `a%`) and `contains: "a\\"` is `LIKE '%a\%'`
    // (ends with `a%`), as PostgreSQL reads them.
    expect(matchesWhere(action("a%"), { notes: { startsWith: "a\\" } })).toBe(true);
    expect(matchesWhere(action("a%x"), { notes: { startsWith: "a\\" } })).toBe(false);
    expect(matchesWhere(action("a\\"), { notes: { startsWith: "a\\" } })).toBe(false);
    expect(matchesWhere(action("xa%"), { notes: { contains: "a\\" } })).toBe(true);
    expect(matchesWhere(action("xa%y"), { notes: { contains: "a\\" } })).toBe(false);
    // `_` is one CHARACTER, as in a UTF-8 PostgreSQL database, not one UTF-16 unit.
    expect(matchesWhere(action("\u{1F600}x"), { notes: { startsWith: "_x" } })).toBe(true);
    expect(matchesWhere(action("\u{1F600}x"), { notes: { startsWith: "__x" } })).toBe(false);
    expect(matchesWhere(action("a\u{1F600}b"), { notes: { contains: "a_b" } })).toBe(true);
    expect(matchesWhere(action("a-b/c"), { notes: { startsWith: "a-b/" } })).toBe(true);
  });

  it("reads a Json column's path + equals as PostgreSQL does: a missing key or NULL matches nothing (#3403)", () => {
    const op = (requestPayload: unknown): WhereRow => ({ id: "op-1", requestPayload });
    const where = { requestPayload: { path: ["paymentIntentId"], equals: "pi_a" } };
    expect(matchesWhere(op({ paymentIntentId: "pi_a" }), where)).toBe(true);
    expect(matchesWhere(op({ paymentIntentId: "pi_b" }), where)).toBe(false);
    expect(matchesWhere(op({}), where)).toBe(false);
    expect(matchesWhere(op(null), where)).toBe(false);
    expect(matchesWhere(op({ paymentIntentId: { id: "pi_a" } }), where)).toBe(false);
    expect(matchesWhere(op({ a: { b: 3 } }), { requestPayload: { path: ["a", "b"], equals: 3 } })).toBe(true);
    // Inside OR, with other clauses, as the production queries use it.
    expect(
      matchesWhere(op({ paymentIntentId: "pi_b" }), {
        OR: [where, { requestPayload: { path: ["paymentIntentId"], equals: "pi_b" } }],
      }),
    ).toBe(true);
    // Under a negation a missing key is unknown: refused, never guessed.
    expect(() => matchesWhere(op({}), { NOT: where })).toThrow(/met a NULL column/);
    // Only path + equals with a scalar is modelled.
    expect(() =>
      matchesWhere(op({}), { requestPayload: { path: ["x"], string_contains: "y" } }),
    ).toThrow(/only path \+ equals/);
    expect(() =>
      matchesWhere(op({}), { requestPayload: { path: ["x"], equals: { y: 1 } } }),
    ).toThrow(/only a scalar/);
  });

  it("reads a Json path equals Prisma.AnyNull as PostgreSQL does: IS NULL at the path, two-valued under NOT (#5228)", () => {
    const op = (requestPayload: unknown): WhereRow => ({ id: "op-1", requestPayload });
    const namesNone = { requestPayload: { path: ["queueType"], equals: Prisma.AnyNull } };
    expect(matchesWhere(op({ invoices: [] }), namesNone)).toBe(true);
    expect(matchesWhere(op({ queueType: null }), namesNone)).toBe(true);
    expect(matchesWhere(op(null), namesNone)).toBe(true);
    expect(matchesWhere(op({ queueType: "BOOKING_INVOICE" }), namesNone)).toBe(false);
    expect(matchesWhere(op({ queueType: "BOOKING_INVOICE" }), { NOT: namesNone })).toBe(true);
    expect(matchesWhere(op({ invoices: [] }), { NOT: namesNone })).toBe(false);
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

  it("evaluates a compound-unique key as its columns, and only that shape", () => {
    const row = { memberId: "m-1", seasonYear: 2026, status: "PAID" };
    expect(
      matchesWhere(row, { memberId_seasonYear: { memberId: "m-1", seasonYear: 2026 } }),
    ).toBe(true);
    expect(
      matchesWhere(row, { memberId_seasonYear: { memberId: "m-1", seasonYear: 2025 } }),
    ).toBe(false);
    // A nested key that is not one of the parts is not this shape.
    expect(() =>
      matchesWhere(row, { memberId_seasonYear: { memberId: "m-1", status: "PAID" } }),
    ).toThrow(/"memberId_seasonYear"/);
    // A relation the fixture never carried must not be re-read against the
    // row's own columns: `member: { id }` here is neither `false` (m-1 is the
    // member's id) nor `true` (b-1 is the booking's own id) — it is an error.
    const bare = { id: "b-1", memberId: "m-1" };
    expect(() => matchesWhere(bare, { member: { id: "m-1" } })).toThrow(/"member"/);
    expect(() => matchesWhere(bare, { member: { id: "b-1" } })).toThrow(/"member"/);
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

  it("throws on a negation over a NULL column, where PostgreSQL excludes and two-valued logic includes", () => {
    const row = booking({ deletedAt: null, notes: null });
    expect(() => matchesWhere(row, { deletedAt: { not: JULY } })).toThrow(
      /`not` on deletedAt met a NULL column/,
    );
    expect(() => matchesWhere(row, { deletedAt: { notIn: [JULY] } })).toThrow(
      /`notIn` on deletedAt met a NULL column/,
    );
    expect(() => matchesWhere(row, { notes: { not: { in: ["x"] } } })).toThrow(
      /`not` on notes met a NULL column/,
    );
    expect(() => matchesWhere(row, { NOT: { deletedAt: JULY } })).toThrow(
      /`NOT` on deletedAt met a NULL column/,
    );
    expect(() => matchesWhere(row, { NOT: { notes: { contains: "x" } } })).toThrow(
      /`NOT` on notes met a NULL column/,
    );
    expect(() => matchesWhere(row, { NOT: [{ status: "PAID" }, { deletedAt: { lt: JULY } }] })).toThrow(
      /`NOT` on deletedAt met a NULL column/,
    );
    expect(() => matchesWhere(row, { NOT: { AND: [{ deletedAt: { in: [JULY] } }] } })).toThrow(
      /`NOT` on deletedAt met a NULL column/,
    );
    // IS NULL / IS NOT NULL are two-valued in SQL and stay ordinary.
    expect(matchesWhere(row, { NOT: { deletedAt: null } })).toBe(false);
    expect(matchesWhere(booking({ deletedAt: JULY }), { NOT: { deletedAt: null } })).toBe(true);
    expect(matchesWhere(row, { deletedAt: { not: null } })).toBe(false);
    // A negation over a non-null value is ordinary.
    expect(matchesWhere(row, { NOT: { status: "PAID" } })).toBe(true);
    expect(matchesWhere(row, { status: { not: "PAID" } })).toBe(true);
    // A relation under NOT is NOT EXISTS, a subquery of its own: the related
    // rows are evaluated un-negated, so a null guest column is an ordinary miss.
    expect(matchesWhere(row, { NOT: { guests: { some: { memberId: "m-9" } } } })).toBe(true);
    expect(matchesWhere(row, { guests: { none: { memberId: "m-9" } } })).toBe(true);
  });

  it("evaluates OR as three-valued logic: any true clause wins over an unknown, in either order", () => {
    const row = booking({ deletedAt: null });
    const isNull = { deletedAt: null };
    const notJuly = { deletedAt: { not: JULY } };
    expect(matchesWhere(row, { OR: [isNull, notJuly] })).toBe(true);
    expect(matchesWhere(row, { OR: [notJuly, isNull] })).toBe(true);
    // A true clause elsewhere in the list also settles it.
    expect(matchesWhere(row, { OR: [notJuly, { status: "CONFIRMED" }] })).toBe(true);
    // No true clause and one unknown: the OR is unknown, and still refuses.
    expect(() => matchesWhere(row, { OR: [notJuly, { status: "PAID" }] })).toThrow(
      /`not` on deletedAt met a NULL column/,
    );
    expect(() => matchesWhere(row, { OR: [{ status: "PAID" }, notJuly] })).toThrow(
      /`not` on deletedAt met a NULL column/,
    );
    // A bare negation over NULL outside such an OR still throws.
    expect(() => matchesWhere(row, { NOT: { deletedAt: JULY } })).toThrow(
      /`NOT` on deletedAt met a NULL column/,
    );
    // A real failure in a clause is never swallowed as "unknown".
    expect(() => matchesWhere(row, { OR: [{ status: "PAID" }, { notes: { mode: "insensitive" } }] })).toThrow(
      /unsupported filter operator "mode"/,
    );
  });

  it("names the caller when a label is given", () => {
    expect(() =>
      matchesWhere(booking(), { notes: { mode: "insensitive" } }, { label: "audit double" }),
    ).toThrow(/^audit double: unsupported/);
  });
});
