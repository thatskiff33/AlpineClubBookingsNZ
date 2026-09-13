/**
 * Reading a failed API response the way an admin surface needs it (#2931): the
 * sentence to show, and the machine-readable code that says WHICH refusal it
 * was.
 *
 * ## Why this module exists
 *
 * Every admin surface that writes through `fetch` has to turn a non-OK reply
 * into a message, and the rule is always the same. Measured on this branch by
 * `api-error-message-census.test.ts`, **21 private copies of it survive across
 * `src/`** — a figure that test prints and pins, so it is measured rather than
 * claimed. This module is not yet "the one way the tree does this"; it is the
 * one home the copies can move to, and this change moves the six in the
 * booking-policy and bed-allocation surfaces it touches. Converging the rest is
 * separate work across surfaces other lanes are editing, and some survivors are
 * not straight copies at all — `servernz-api.ts` strips control characters,
 * `email-message-settings-panel.tsx` appends zod issues, `admin-member-xero-actions.ts`
 * returns an error object rather than a string. Those need a judgement, not a
 * sweep. The census names each survivor by path so a NEW private copy trips it.
 *
 * ## The rule these functions own
 *
 *  - **Only `error` is read, and only when it is a non-empty string.** Our API
 *    routes answer a refusal with a curated `{ error }` sentence; everything
 *    else in the body — zod's `details`, a provider payload, a Prisma `meta` —
 *    stays where it is. That projection IS the sanitisation boundary: a caller
 *    cannot accidentally surface internal detail it never reads.
 *  - **The body is never read as text.** A proxy, an edge error page or a
 *    crashed route answers with HTML, and `response.text()` would put that
 *    markup straight in front of the admin. A body that is not JSON, is not an
 *    object, or carries no usable `error` falls back to the caller's own safe
 *    sentence.
 *  - **Blank counts as absent.** `{ error: "" }` renders an empty alert, which
 *    reads as a UI bug rather than as a refusal; the fallback is better. Three
 *    of the copies converged here used `?? fallback`, which renders the blank.
 *
 * ## Two shapes, named so they cannot be confused
 *
 * Eleven files still declare a local `responseErrorMessage(body, fallback)` —
 * the same rule one step later, after the caller has already awaited `.json()`.
 * An export called `responseErrorMessage` that took a `Response` would sit
 * beside eleven functions of that name taking a body, and an auto-import would
 * collide in silence. So both shapes live here and both say which they take:
 * {@link apiErrorMessageFromBody} for a parsed body, and
 * {@link apiErrorMessageFromResponse} for a `Response` it parses itself.
 */

/**
 * The code a route sets on a refusal that means "this optional module is
 * switched off for this club".
 *
 * A status code cannot carry this. A module-gated route answers 404 for the
 * module being off AND for an anonymous caller, on purpose — see
 * `moduleGatedNotFoundResponse` in `src/lib/session-guards.ts`, which hides
 * which optional modules a club runs from a single unauthenticated probe. A
 * screen that reads 404 as "module off" therefore tells an admin whose sign-in
 * expired to go and switch on a module, which is a wrong diagnosis and not a
 * vague one. Naming the module refusal in the body settles it: the code is set
 * only AFTER the caller has been authenticated and permitted, so the anonymous
 * 404 still carries nothing and gives nothing away.
 *
 * `custodian-assignment.ts` types its own `MODULE_DISABLED` refusal from this
 * constant. The two hut-leader routes still spell the literal: routing them
 * here costs an import line in a file the size ratchet holds at an allowance
 * another lane recorded, and amending that lane's allowance to carry a one-line
 * import is the shared-file edit the fragment rule exists to avoid. It belongs
 * with the next change to those routes rather than with this one.
 */
export const MODULE_DISABLED_ERROR_CODE = "MODULE_DISABLED";

function errorObject(body: unknown): { error?: unknown; code?: unknown } | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { error?: unknown; code?: unknown })
    : null;
}

/** The sentence to show, from a body the caller has already parsed. */
export function apiErrorMessageFromBody(body: unknown, fallback: string): string {
  const error = errorObject(body)?.error;
  const message = typeof error === "string" ? error.trim() : "";
  return message === "" ? fallback : message;
}

/**
 * The refusal's machine-readable `code`, or `null` when the body carries none.
 * Compare against {@link MODULE_DISABLED_ERROR_CODE} rather than inferring a
 * refusal from the status.
 */
export function apiErrorCodeFromBody(body: unknown): string | null {
  const code = errorObject(body)?.code;
  return typeof code === "string" && code !== "" ? code : null;
}

/**
 * Parse a failed response's body once, safely.
 *
 * A `Response` body can only be read once, so a caller that needs both the code
 * and the message must parse here and then use the `FromBody` functions — not
 * call {@link apiErrorMessageFromResponse} and then try to read the body again.
 */
export async function readApiErrorBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/** The sentence to show, for a caller that needs nothing but the sentence. */
export async function apiErrorMessageFromResponse(
  response: Response,
  fallback: string,
): Promise<string> {
  return apiErrorMessageFromBody(await readApiErrorBody(response), fallback);
}
