import { z } from "zod";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import {
  OTHER_LODGE_BOUNDS,
  OTHER_LODGE_RATE_FIELDS,
  type OtherLodgeRateField,
} from "@/lib/other-lodges";

/**
 * The ONE place a non-member rate crosses between this site and the Alpine
 * Central Server (server API 2.2, #61; INV-MONEY-001, INV-MONEY-003).
 *
 * Here a rate is INTEGER CENTS, under a `…Cents` column name. On the wire it is
 * a JSON NUMBER OF DOLLARS (`45.5`) under the server's name without the suffix
 * (`winterRateAdult`) — the owner's decision on #61 (D1), matching the server.
 *
 * ## Inbound contract (`serverRateToCents`)
 *
 * - Accepted only when it is a finite `number` in `0`–`99999.99` whose shortest
 *   decimal form has at most two places. That form is read from the number's
 *   own string (`String(45.5)` is `"45.5"`), so the check does no arithmetic.
 * - Then converted by `providerAmountToCents`, the reviewed boundary for an
 *   already-numeric amount from another system. For a value with at most two
 *   places it lands on the exact cent.
 * - Anything else returns `null` — never a zero.
 *
 * ## Outbound contract (`centsToServerRate`)
 *
 * - Integer cents in range → `cents / 100`, whose shortest decimal form is the
 *   exact dollars-and-cents value, so JSON prints `45.5` for 4550.
 */

/** The server's name for each rate: the column name without `Cents`. */
export const SERVER_RATE_WIRE_NAMES = {
  winterRateUnder5Cents: "winterRateUnder5",
  winterRate5To11Cents: "winterRate5To11",
  winterRate12To17Cents: "winterRate12To17",
  winterRateAdultCents: "winterRateAdult",
  summerRateUnder5Cents: "summerRateUnder5",
  summerRate5To11Cents: "summerRate5To11",
  summerRate12To17Cents: "summerRate12To17",
  summerRateAdultCents: "summerRateAdult",
} as const satisfies Record<OtherLodgeRateField, string>;

export type ServerRateWireName =
  (typeof SERVER_RATE_WIRE_NAMES)[OtherLodgeRateField];

/** A rate as the server sends and receives it: dollars, or null for not set. */
export type ServerRates = { [K in ServerRateWireName]: number | null };

/** Dollars-and-cents in its shortest decimal form: `45`, `45.5`, `45.55`. */
const TWO_PLACES = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/** A rate from the server in cents, or null when it is not a valid rate. */
export function serverRateToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!TWO_PLACES.test(String(value))) return null;
  const cents = providerAmountToCents(value);
  if (cents === null || cents < 0 || cents > OTHER_LODGE_BOUNDS.rateCentsMax) {
    return null;
  }
  return cents;
}

/** A stored rate in the server's dollars. */
export function centsToServerRate(cents: number): number {
  return cents / 100;
}

/**
 * The rates on a pulled lodge: each OPTIONAL (absent leaves the stored rate
 * alone), `null` clears it, and anything else must be a valid rate or the row
 * fails and is dropped by the pull, like every other out-of-bounds field.
 */
export const serverRateWireShape = Object.fromEntries(
  OTHER_LODGE_RATE_FIELDS.map((field) => [
    SERVER_RATE_WIRE_NAMES[field],
    z
      .number()
      .refine((v) => serverRateToCents(v) !== null, "Rates are 0 to 99999.99 dollars, at most two decimal places")
      .nullable()
      .optional(),
  ]),
) as { [K in ServerRateWireName]: z.ZodOptional<z.ZodNullable<z.ZodNumber>> };

/**
 * The server's rate keys to this site's cents columns. A key the server did
 * not send stays absent, so it is never read as "set to null".
 */
export function ratesFromServer(
  wire: Partial<Record<ServerRateWireName, number | null | undefined>>,
): Partial<Record<OtherLodgeRateField, number | null>> {
  const out: Partial<Record<OtherLodgeRateField, number | null>> = {};
  for (const field of OTHER_LODGE_RATE_FIELDS) {
    const value = wire[SERVER_RATE_WIRE_NAMES[field]];
    if (value === undefined) continue;
    out[field] = value === null ? null : serverRateToCents(value);
  }
  return out;
}

/** This site's cents columns as the server's dollar keys, every one present. */
export function ratesToServer(
  record: Record<OtherLodgeRateField, number | null>,
): ServerRates {
  const out = {} as ServerRates;
  for (const field of OTHER_LODGE_RATE_FIELDS) {
    const cents = record[field];
    out[SERVER_RATE_WIRE_NAMES[field]] = cents === null ? null : centsToServerRate(cents);
  }
  return out;
}
