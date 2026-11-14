import { z } from "zod";

import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";

/**
 * The request-side schemas for a date-only `YYYY-MM-DD` field (#4931): THE one
 * declaration every route and request parser imports, instead of wrapping
 * `isDateOnlyString` in its own `z.string().refine(...)`.
 *
 * Only the predicate used to be shared, so the wrapper around it — and the
 * message that wrapper attaches — was copied into 27 files, and two copies had
 * already drifted to other wording. `date-only-schema.test.ts` refuses a new
 * copy anywhere under `src/`.
 *
 * A sibling of `date-only.ts` rather than part of it because client components
 * import that module for its pure helpers, and this one brings in zod.
 *
 * Not for a guest's chosen nights: those carry the member-worded
 * `GUEST_NIGHT_INVALID_MESSAGE` from `booking-guest-stay-range-input.ts` (#4088).
 * A member typing their own or a family member's date of birth gets
 * `dateOfBirthStringSchema`, the same check in words that name the field.
 *
 * A bare `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` is refused too (ALP-574): it
 * checks the shape only, so it lets through a day that does not exist, such as
 * `2026-02-30`, which then becomes an Invalid Date further on.
 */

/** What a request is told about a date field that is not a real calendar day. */
export const DATE_ONLY_INVALID_MESSAGE = "Date must be YYYY-MM-DD";

/** A real calendar day as `YYYY-MM-DD`, kept as the string it arrived as. */
export const dateOnlyStringSchema = z.string().refine(isDateOnlyString, {
  message: DATE_ONLY_INVALID_MESSAGE,
});

/** A real calendar day as `YYYY-MM-DD`, parsed to its date-only `Date` (UTC midnight). */
export const parsedDateOnlySchema = dateOnlyStringSchema.transform(parseDateOnly);

/** What a member is told about a date of birth that is not a real calendar day. */
export const DATE_OF_BIRTH_INVALID_MESSAGE = "Date of birth must be a real date as YYYY-MM-DD";

/** A member-entered date of birth: a real calendar day as `YYYY-MM-DD`, kept as a string. */
export const dateOfBirthStringSchema = z.string().refine(isDateOnlyString, {
  message: DATE_OF_BIRTH_INVALID_MESSAGE,
});
