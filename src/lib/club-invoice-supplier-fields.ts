import { z } from "zod";

/**
 * The rules for the two Club identity fields the generated booking invoice
 * prints as its supplier (#5066): one home the admin save
 * (`/api/admin/club-identity`) and config-transfer import both apply, so a
 * bundle cannot bring in a value the admin form would refuse.
 *
 * - The legal name is one line of at most 200 characters: it is drawn as the
 *   supplier heading, and a line break would split it.
 * - The postal address is at most 500 characters over as many lines as needed
 *   (`postalAddressLines`).
 */
export const CLUB_LEGAL_NAME_LIMIT = 200;
export const CLUB_POSTAL_ADDRESS_LIMIT = 500;

export const clubLegalNameSchema = z
  .string()
  .trim()
  .max(CLUB_LEGAL_NAME_LIMIT)
  .refine((value) => !/[\r\n]/.test(value), { message: "legalName must be one line" });

export const clubPostalAddressSchema = z.string().trim().max(CLUB_POSTAL_ADDRESS_LIMIT);

export const CLUB_INVOICE_SUPPLIER_REFUSAL =
  `Legal name: one line, at most ${CLUB_LEGAL_NAME_LIMIT} characters. Postal address: at most ${CLUB_POSTAL_ADDRESS_LIMIT} characters.`;

/** Config transfer's per-field checks (null is "no override" and always allowed). */
export const CLUB_INVOICE_SUPPLIER_IMPORT_CONSTRAINTS = Object.fromEntries(
  ([
    ["legalName", clubLegalNameSchema],
    ["postalAddress", clubPostalAddressSchema],
  ] as const).map(([field, schema]) => [
    field,
    {
      validate: (value: unknown) =>
        value === null || schema.safeParse(value).success ? null : CLUB_INVOICE_SUPPLIER_REFUSAL,
    },
  ]),
);
