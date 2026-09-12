import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RawSqlShapeError,
  decodeRawRows,
  rawIntColumn,
} from "@/lib/raw-sql-rows";

// #2289. The decoder exists because `$queryRaw<T>` is an unchecked cast: raw SQL
// returns the PHYSICAL column names and the generic declares whatever the author
// believed, so a disagreement arrives as `undefined` rather than as an error.
// These tests pin the two halves of that contract — the right shape flows
// through untouched, and every wrong shape throws naming the column.

const PROMO_ROW = z.object({
  id: z.string(),
  maxRedemptionsTotal: z.number().nullable(),
  freeNightsPerIndividual: z.number().nullable(),
  active: z.boolean(),
});

describe("decodeRawRows (#2289)", () => {
  it("returns the rows typed when the shape matches", () => {
    const rows = decodeRawRows(
      [
        {
          id: "promo-1",
          maxRedemptionsTotal: 10,
          freeNightsPerIndividual: 2,
          active: true,
        },
      ],
      PROMO_ROW,
      "promo lock",
    );

    expect(rows).toEqual([
      {
        id: "promo-1",
        maxRedemptionsTotal: 10,
        freeNightsPerIndividual: 2,
        active: true,
      },
    ]);
    // Nulls are data, not absence: a promo with no cap must still decode.
    expect(
      decodeRawRows(
        [{ id: "p", maxRedemptionsTotal: null, freeNightsPerIndividual: null, active: false }],
        PROMO_ROW,
        "promo lock",
      )[0].maxRedemptionsTotal,
    ).toBeNull();
  });

  it("accepts an empty result set", () => {
    expect(decodeRawRows([], PROMO_ROW, "promo lock")).toEqual([]);
  });

  it("throws naming the MISSING column — the exact shape that disabled the promo cap", () => {
    // What a database whose physical columns were snake_case actually returned.
    const renamed = [
      {
        id: "promo-1",
        max_redemptions_total: 10,
        free_nights_per_individual: 2,
        active: true,
      },
    ];

    expect(() => decodeRawRows(renamed, PROMO_ROW, "promo lock")).toThrow(
      RawSqlShapeError,
    );
    try {
      decodeRawRows(renamed, PROMO_ROW, "promo lock");
      expect.unreachable("expected a RawSqlShapeError");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("promo lock");
      expect(message).toContain("maxRedemptionsTotal");
      expect(message).toContain("undefined (column absent)");
      // The columns that DID arrive are listed, so a rename names itself.
      expect(message).toContain("max_redemptions_total");
    }
  });

  it("throws on a wrong column type rather than letting it through", () => {
    expect(() =>
      decodeRawRows(
        [
          {
            id: "promo-1",
            maxRedemptionsTotal: "10",
            freeNightsPerIndividual: 2,
            active: true,
          },
        ],
        PROMO_ROW,
        "promo lock",
      ),
    ).toThrow(/maxRedemptionsTotal[\s\S]*string/);
  });

  it("names the row index so a bad row in a multi-row result is findable", () => {
    expect(() =>
      decodeRawRows(
        [
          { id: "a", maxRedemptionsTotal: 1, freeNightsPerIndividual: 1, active: true },
          { id: "b", maxRedemptionsTotal: 1, freeNightsPerIndividual: 1 },
        ],
        PROMO_ROW,
        "promo lock",
      ),
    ).toThrow(/row 1/);
  });

  it("throws when the driver returns something that is not an array of rows", () => {
    expect(() => decodeRawRows(undefined, PROMO_ROW, "promo lock")).toThrow(
      /expected raw SQL to return an array of rows/,
    );
    expect(() => decodeRawRows({ id: "p" }, PROMO_ROW, "promo lock")).toThrow(
      RawSqlShapeError,
    );
    expect(() => decodeRawRows([null], PROMO_ROW, "promo lock")).toThrow(
      RawSqlShapeError,
    );
  });

  it("never puts a column VALUE in the message (it travels to logs and Sentry)", () => {
    try {
      decodeRawRows(
        [{ id: "promo-1", maxRedemptionsTotal: "SECRET-VALUE", freeNightsPerIndividual: 1, active: true }],
        PROMO_ROW,
        "promo lock",
      );
      expect.unreachable("expected a RawSqlShapeError");
    } catch (error) {
      expect((error as Error).message).not.toContain("SECRET-VALUE");
    }
  });

  it("leaves unknown columns alone but still requires the declared ones", () => {
    const row = decodeRawRows(
      [
        {
          id: "promo-1",
          maxRedemptionsTotal: 1,
          freeNightsPerIndividual: 1,
          active: true,
          archivedAt: null,
          xeroItemCode: "SALES",
        },
      ],
      PROMO_ROW,
      "promo lock",
    )[0];
    expect(row).not.toHaveProperty("xeroItemCode");

    // A caller that wants exhaustiveness asks for it.
    expect(() =>
      decodeRawRows(
        [{ id: "p", surprise: 1 }],
        z.strictObject({ id: z.string() }),
        "strict",
      ),
    ).toThrow(RawSqlShapeError);
  });
});

describe("rawIntColumn — what Postgres actually sends (#2289)", () => {
  const schema = z.object({ count: rawIntColumn });

  it("accepts an int4 number", () => {
    expect(decodeRawRows([{ count: 7 }], schema, "counter")[0].count).toBe(7);
  });

  // The value arrives as a BigInt at runtime, which is the trap: nothing in the
  // row's declared type says so.
  it("accepts the BigInt that COUNT(*) and int8 return, and narrows it to a number", () => {
    const decoded = decodeRawRows([{ count: 42n }], schema, "counter")[0];
    expect(decoded.count).toBe(42);
    expect(typeof decoded.count).toBe("number");
    // The trap this closes: arithmetic on the raw value throws.
    expect(() => (42n as unknown as number) + 1).toThrow(TypeError);
  });

  it("refuses a BigInt too large to convert without losing precision", () => {
    expect(() =>
      decodeRawRows([{ count: BigInt("9007199254740993") }], schema, "counter"),
    ).toThrow(/safe integer range/);
  });

  it("refuses a numeric STRING instead of guessing at Number(\"12.50\")", () => {
    expect(() => decodeRawRows([{ count: "12.50" }], schema, "counter")).toThrow(
      RawSqlShapeError,
    );
  });

  it("refuses the Prisma.Decimal a numeric/decimal column really sends", () => {
    // What the installed runtime actually hands back for a `numeric` column
    // read raw: `@prisma/client` maps the adapter's Numeric type to "decimal"
    // and deserialises it with `new Decimal(value)` — an OBJECT, not the string
    // this file's reference block used to claim. The message names the
    // constructor so the mismatch diagnoses itself.
    class Decimal {
      constructor(readonly value: string) {}
    }
    expect(() =>
      decodeRawRows([{ count: new Decimal("12.50") }], schema, "counter"),
    ).toThrow(/Decimal object/);
  });

  it("refuses a fractional number", () => {
    expect(() => decodeRawRows([{ count: 1.5 }], schema, "counter")).toThrow(
      /expected an integer/,
    );
  });
});
