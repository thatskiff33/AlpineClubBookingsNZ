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
 */

/** What a request is told about a date field that is not a real calendar day. */
export const DATE_ONLY_INVALID_MESSAGE = "Date must be YYYY-MM-DD";

/** A real calendar day as `YYYY-MM-DD`, kept as the string it arrived as. */
export const dateOnlyStringSchema = z.string().refine(isDateOnlyString, {
  message: DATE_ONLY_INVALID_MESSAGE,
});

/** A real calendar day as `YYYY-MM-DD`, parsed to its date-only `Date` (UTC midnight). */
export const parsedDateOnlySchema = dateOnlyStringSchema.transform(parseDateOnly);
