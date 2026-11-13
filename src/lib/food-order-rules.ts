/**
 * The food-order limits and pure rules (fork #121).
 *
 * A CLIENT-SAFE MODULE ON PURPOSE, like `maintenance-report-limits.ts`: the
 * order form, the history page and the settings card import these in the
 * browser, and the server routes import the SAME numbers, so the UI can never
 * offer something the server refuses (INV-SSOT). No Prisma, no `server-only`,
 * no club-time server reader.
 */
import { MAX_INTEGER_CENTS } from "@/lib/money-input";

/** An order holds 1 to 50 item lines (fork #121 owner decision 13, issue item 6). */
export const FOOD_ORDER_MIN_ITEMS = 1;
export const FOOD_ORDER_MAX_ITEMS = 50;

/** Each line's description: required, up to 200 characters. */
export const FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH = 200;

/**
 * Each line's quantity (owner change, 13 Nov 2026): a decimal greater than 0,
 * at most two decimal places, at most 99999.99 — grams need more than 999.
 * Stored as `Decimal(7,2)`; carried as a STRING everywhere (JSON, forms, email),
 * never as a binary float, and compared and formatted as text only.
 */
export const FOOD_ORDER_ITEM_QUANTITY_MAX = "99999.99";

/**
 * The unit a quantity is counted in — the owner's "Type" list, in the owner's
 * order. The codes are the `FoodOrderUnit` enum; the labels are what people see,
 * singular for exactly 1 and plural otherwise ("1 Packet", "0.5 Packets").
 * "Box"/"Boxes" is the correct plural of the owner's "Boxs"; "Liter" and
 * "Milliliter" keep the owner's spelling.
 */
export const FOOD_ORDER_UNITS = [
  "ITEMS",
  "GRAMS",
  "KILOGRAMS",
  "LITERS",
  "LOAVES",
  "PACKETS",
  "BOTTLES",
  "CANS",
  "BAGS",
  "BOXES",
  "PUNNETS",
  "MILLILITERS",
] as const;
export type FoodOrderUnitValue = (typeof FOOD_ORDER_UNITS)[number];

export const DEFAULT_FOOD_ORDER_UNIT: FoodOrderUnitValue = "ITEMS";

export const FOOD_ORDER_UNIT_LABELS: Record<
  FoodOrderUnitValue,
  { singular: string; plural: string }
> = {
  ITEMS: { singular: "Item", plural: "Items" },
  GRAMS: { singular: "Gram", plural: "Grams" },
  KILOGRAMS: { singular: "Kilogram", plural: "Kilograms" },
  LITERS: { singular: "Liter", plural: "Liters" },
  LOAVES: { singular: "Loaf", plural: "Loaves" },
  PACKETS: { singular: "Packet", plural: "Packets" },
  BOTTLES: { singular: "Bottle", plural: "Bottles" },
  CANS: { singular: "Can", plural: "Cans" },
  BAGS: { singular: "Bag", plural: "Bags" },
  BOXES: { singular: "Box", plural: "Boxes" },
  PUNNETS: { singular: "Punnet", plural: "Punnets" },
  MILLILITERS: { singular: "Milliliter", plural: "Milliliters" },
};

export function isFoodOrderUnit(value: unknown): value is FoodOrderUnitValue {
  return FOOD_ORDER_UNITS.some((unit) => unit === value);
}

/**
 * A quantity as a person may type it, or null. Digits only, no sign, no
 * exponent, no leading zeros (except "0.x"), at most five whole digits and two
 * decimals, greater than zero. Returns the NORMALISED text: trailing zeros and a
 * bare point dropped ("1.50" -> "1.5", "2.00" -> "2"). Pure string work, so no
 * binary float ever touches a quantity.
 */
export function parseFoodOrderQuantity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d{0,4})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (whole === "0" && fraction === "") return null;
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * A stored quantity's text (`Decimal(7,2)` rendered with two places, e.g.
 * "2.00") in the normalised form `parseFoodOrderQuantity` returns ("2").
 */
export function normaliseStoredFoodOrderQuantity(value: string): string {
  return parseFoodOrderQuantity(value) ?? value;
}

/** The unit's label for this quantity: singular only when it is exactly 1. */
export function foodOrderUnitLabel(quantity: string, unit: FoodOrderUnitValue): string {
  const labels = FOOD_ORDER_UNIT_LABELS[unit];
  return parseFoodOrderQuantity(quantity) === "1" ? labels.singular : labels.plural;
}

/**
 * The ONE rendering of a quantity and its unit — "1 Packet", "0.5 Packets",
 * "2 Loaves", "250 Grams" — used by the form, the history, the checklist, the
 * email and the audit rows, so nothing pluralises a second way.
 */
export function formatFoodOrderQuantity(quantity: string, unit: FoodOrderUnitValue): string {
  const shown = parseFoodOrderQuantity(quantity) ?? quantity;
  return `${shown} ${foodOrderUnitLabel(shown, unit)}`;
}

/** One item line as shown everywhere: "2 Loaves — Wholemeal bread". */
export function formatFoodOrderItemLine(item: {
  quantity: string;
  unit: FoodOrderUnitValue;
  description: string;
}): string {
  return `${formatFoodOrderQuantity(item.quantity, item.unit)} — ${item.description}`;
}

/** The optional note on an order. Matches the `FoodOrder.notes` column. */
export const FOOD_ORDER_NOTES_MAX_LENGTH = 1000;

/** What the officer's email says for an order with no note, in HTML and text alike. */
export const FOOD_ORDER_NO_NOTE_TEXT = "No note was added.";

/** The officer label (INV-CONFIG-001) and its default. */
export const DEFAULT_FOOD_OFFICER_LABEL = "Food officer";
export const FOOD_OFFICER_LABEL_MAX_LENGTH = 60;

/** The officer email column's width (RFC 5321's practical maximum). */
export const FOOD_OFFICER_EMAIL_MAX_LENGTH = 254;

/**
 * The largest price a person may record: the integer-cents ceiling every money
 * column shares (INV-MONEY-001). The price is a record only and moves no money.
 */
export const FOOD_ORDER_PRICE_CENTS_MAX = MAX_INTEGER_CENTS;

/** How many orders one history page shows. */
export const FOOD_ORDER_HISTORY_PAGE_SIZE = 25;

export const FOOD_ORDER_STATUSES = ["OPEN", "RECEIVED"] as const;
export type FoodOrderStatusValue = (typeof FOOD_ORDER_STATUSES)[number];

export const FOOD_ORDER_STATUS_LABELS: Record<FoodOrderStatusValue, string> = {
  OPEN: "Open",
  RECEIVED: "Received",
};

export type FoodOrderItemInput = {
  description: string;
  /** As typed or sent: checked with `parseFoodOrderQuantity`. */
  quantity: string;
  unit: string;
};

/**
 * Why a set of item lines would be refused, or null when it is acceptable.
 * The one rule the form and the create route both apply.
 */
export function foodOrderItemsProblem(
  items: readonly FoodOrderItemInput[],
): string | null {
  if (items.length < FOOD_ORDER_MIN_ITEMS) {
    return "Add at least one item to the order.";
  }
  if (items.length > FOOD_ORDER_MAX_ITEMS) {
    return `An order can hold up to ${FOOD_ORDER_MAX_ITEMS} items.`;
  }
  for (const item of items) {
    const description = item.description.trim();
    if (description.length === 0) {
      return "Every item needs a description.";
    }
    if (description.length > FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH) {
      return `Keep each description to ${FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH} characters.`;
    }
    if (parseFoodOrderQuantity(item.quantity) === null) {
      return `Each quantity must be more than 0 and at most ${FOOD_ORDER_ITEM_QUANTITY_MAX}, with up to two decimal places.`;
    }
    if (!isFoodOrderUnit(item.unit)) {
      return "Choose a type for every item.";
    }
  }
  return null;
}

/** Whether a recorded price is acceptable: integer cents, 0 to the ceiling. */
export function isValidFoodOrderPriceCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= FOOD_ORDER_PRICE_CENTS_MAX
  );
}
