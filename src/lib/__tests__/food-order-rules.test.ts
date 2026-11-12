import { describe, expect, it } from "vitest";

import {
  DEFAULT_FOOD_ORDER_UNIT,
  FOOD_ORDER_UNITS,
  FOOD_ORDER_UNIT_LABELS,
  foodOrderItemsProblem,
  foodOrderUnitLabel,
  formatFoodOrderItemLine,
  formatFoodOrderQuantity,
  isFoodOrderUnit,
  normaliseStoredFoodOrderQuantity,
  parseFoodOrderQuantity,
} from "@/lib/food-order-rules";

/**
 * Fork #121 (owner change, 13 Nov 2026): the "Type" list, singular versus
 * plural, and the decimal quantity parser — the one module the form, the
 * routes, the history, the checklist, the email and the audit rows all use.
 */

describe("the Type list", () => {
  it("holds the owner's twelve types, in the owner's order, defaulting to Items", () => {
    expect(FOOD_ORDER_UNITS.map((unit) => FOOD_ORDER_UNIT_LABELS[unit].plural)).toEqual([
      "Items",
      "Grams",
      "Kilograms",
      "Liters",
      "Loaves",
      "Packets",
      "Bottles",
      "Cans",
      "Bags",
      "Boxes",
      "Punnets",
      "Milliliters",
    ]);
    expect(DEFAULT_FOOD_ORDER_UNIT).toBe("ITEMS");
    expect(isFoodOrderUnit("PACKETS")).toBe(true);
    expect(isFoodOrderUnit("CRATES")).toBe(false);
    expect(isFoodOrderUnit("packets")).toBe(false);
  });
});

describe("singular versus plural", () => {
  const table: Array<[string, (typeof FOOD_ORDER_UNITS)[number], string]> = [
    ["1", "PACKETS", "1 Packet"],
    ["0.5", "PACKETS", "0.5 Packets"],
    ["2", "PACKETS", "2 Packets"],
    ["1.00", "PACKETS", "1 Packet"],
    ["1.5", "PACKETS", "1.5 Packets"],
    ["1", "LOAVES", "1 Loaf"],
    ["2", "LOAVES", "2 Loaves"],
    ["1", "BOXES", "1 Box"],
    ["3", "BOXES", "3 Boxes"],
    ["250", "GRAMS", "250 Grams"],
    ["1", "ITEMS", "1 Item"],
    ["0.25", "MILLILITERS", "0.25 Milliliters"],
    ["1", "LITERS", "1 Liter"],
  ];
  for (const [quantity, unit, expected] of table) {
    it(`${quantity} ${unit} reads "${expected}"`, () => {
      expect(formatFoodOrderQuantity(quantity, unit)).toBe(expected);
    });
  }

  it("labels the Type options by the line's quantity", () => {
    expect(foodOrderUnitLabel("1", "BAGS")).toBe("Bag");
    expect(foodOrderUnitLabel("0.5", "BAGS")).toBe("Bags");
    // A half-typed or invalid quantity is not exactly 1, so the plural shows.
    expect(foodOrderUnitLabel("", "BAGS")).toBe("Bags");
    expect(foodOrderUnitLabel("1.", "BAGS")).toBe("Bags");
  });

  it("formats a whole line the one way", () => {
    expect(
      formatFoodOrderItemLine({ quantity: "2", unit: "LOAVES", description: "Wholemeal" }),
    ).toBe("2 Loaves — Wholemeal");
  });
});

describe("the quantity parser", () => {
  const accepted: Array<[string, string]> = [
    ["1", "1"],
    ["0.5", "0.5"],
    ["0.50", "0.5"],
    ["2.00", "2"],
    ["1.25", "1.25"],
    ["0.01", "0.01"],
    ["99999.99", "99999.99"],
    [" 12 ", "12"],
    ["250", "250"],
  ];
  for (const [input, normalised] of accepted) {
    it(`accepts ${JSON.stringify(input)} as ${normalised}`, () => {
      expect(parseFoodOrderQuantity(input)).toBe(normalised);
    });
  }

  const refused: unknown[] = [
    "0",
    "0.0",
    "0.00",
    "-1",
    "+1",
    "1.005",
    "100000",
    "100000.00",
    "1e3",
    "1E2",
    "NaN",
    "Infinity",
    "",
    " ",
    ".5",
    "1.",
    "01",
    "1,5",
    "0x10",
    1,
    0.5,
    null,
    undefined,
  ];
  for (const input of refused) {
    it(`refuses ${JSON.stringify(input) ?? String(input)}`, () => {
      expect(parseFoodOrderQuantity(input)).toBeNull();
    });
  }

  it("normalises a stored two-place decimal", () => {
    expect(normaliseStoredFoodOrderQuantity("2.00")).toBe("2");
    expect(normaliseStoredFoodOrderQuantity("0.50")).toBe("0.5");
    expect(normaliseStoredFoodOrderQuantity("12345.67")).toBe("12345.67");
  });
});

describe("item-line validation", () => {
  it("accepts a decimal quantity with a known type", () => {
    expect(foodOrderItemsProblem([{ description: "Rice", quantity: "0.5", unit: "PACKETS" }])).toBeNull();
  });
  it("refuses an invalid quantity and an unknown type", () => {
    expect(foodOrderItemsProblem([{ description: "Rice", quantity: "0", unit: "PACKETS" }])).toMatch(
      /more than 0/,
    );
    expect(foodOrderItemsProblem([{ description: "Rice", quantity: "1", unit: "CRATES" }])).toMatch(
      /type/,
    );
  });
});
