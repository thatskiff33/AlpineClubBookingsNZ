import { readValidationDetails } from "@/lib/format-validation-errors";

/**
 * Why an admin list API refused a query, in words an operator can act on.
 *
 * The admin list routes validate their query string with zod and answer a bad
 * one with `{ error, details: <zod flatten()> }` and a 400. The useful sentence
 * is the FIELD message — "Enter an amount in dollars and cents…", "Amount max
 * must be greater than or equal to amount min" — not the generic `error`.
 *
 * This exists because the payments screen used to run `if (res.ok) { … }` with
 * no `else`: a refused query left the previous query's rows on screen under a
 * filter chip that had never been applied, and the reason was only visible in a
 * network panel (#2685 review). A screen calling this renders what it returns
 * and clears its dataset.
 *
 * Everything about the body is treated as untrusted: a 403, a 500, an HTML error
 * page, or a shape that is not zod's at all falls back to `fallback` rather than
 * showing the operator nothing or a fragment of a stack trace.
 */
export async function readAdminQueryErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return fallback;
  }

  // The one reader of a validation refusal's `details` (#4467): the first
  // field message, else the first form-level one.
  const details = readValidationDetails(payload);
  return details?.fieldErrors[0]?.[1][0] ?? details?.formErrors[0] ?? fallback;
}

/**
 * The sentences an admin list shows when its read fails without a refusal to
 * quote (#4961), shared so the four pages that render `AdminLoadError` cannot
 * drift into four wordings of one outage.
 *
 * Neither sentence says anything about what was or was not saved. Each read is
 * also re-run straight after a write (a send, a payment, a PIN reset), where a
 * "nothing was changed" claim would sit beside the page's own success message.
 */
export const ADMIN_LOAD_NETWORK_ERROR =
  "The server could not be reached. Check your connection, then try again.";
export const ADMIN_LOAD_FAILED_ERROR =
  "The server could not answer just now. Try again.";
