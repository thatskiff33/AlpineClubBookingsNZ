/**
 * Reading a failed API response the way an admin surface needs it (#2931): the
 * sentence to show, and the machine-readable code that says WHICH refusal it
 * was.
 *
 * ## Why this module exists
 *
 * Every admin surface that writes through `fetch` has to turn a non-OK reply
 * into a message, and the rule is always the same. #2931 wrote this one home
 * and measured that **21 private copies** of the rule survived across `src/`,
 * drifted into three behaviours: most rendered an EMPTY red alert on a blank
 * message (`?? fallback`), one fell back correctly (`|| fallback`), and none
 * checked the message was text, so an object rendered as `[object Object]`.
 * #3445 converged every one of them, and `api-error-message-census.test.ts`
 * now asserts that **no private copy exists** outside this file — failing
 * closed, so a twenty-second reading of the rule is reported with its path.
 *
 * ## The two answers #3445 settled, on every admin surface
 *
 *  - **A blank message falls back to the screen's own fixed sentence.**
 *    `{ error: "" }` and `{ error: "   " }` are the fallback, never an empty
 *    alert.
 *  - **A non-text message falls back rather than being stringified.**
 *    `{ error: { code: 7 } }` is the fallback, never `[object Object]`.
 *
 * Both are pinned by `api-error-message.test.ts`, with a real string passing
 * through, so a copy that drifts back is a failing test and not a screen an
 * officer has to report.
 *
 * ## Deliberately different readers, and why
 *
 * Three surfaces EXTEND the rule. Each hands the sentence itself to
 * {@link apiErrorMessageFromBody} and keeps only its extension, so the two
 * answers above hold there too:
 *
 *  - `src/app/(admin)/admin/xero/_components/api.ts` — the Xero routes
 *    sometimes answer with a `message` key rather than `error`; that second key
 *    is read once and handed to the shared rule as the fallback.
 *  - `src/components/admin/email-settings/email-message-settings-panel.tsx` —
 *    prefers a validation error's issue list, joined onto the headline (#2267);
 *    the headline is the shared rule's sentence.
 *  - `src/lib/admin-member-xero-actions.ts` — returns an error OBJECT carrying
 *    recovery hints beside the sentence; the sentence is the shared rule's.
 *
 * One reader stays in the private shape and is allowlisted by path in the
 * census with its reason:
 *
 *  - `src/lib/servernz-api.ts` — a server-side read of a REMOTE provider's
 *    error text. Its fallback carries the HTTP status, and its sentence is
 *    stripped of control characters and capped in length before
 *    `respondToSyncError` writes it to the audit log. That bounding is the
 *    point of the reader, not an accident of where it lives.
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
 *    reads as a UI bug rather than as a refusal; the fallback is better. Most
 *    of the copies converged here used `?? fallback`, which renders the blank.
 *
 * ## Two shapes, named so they cannot be confused
 *
 * Eleven of the copies #3445 deleted were a local
 * `responseErrorMessage(body, fallback)` — the same rule one step later, after
 * the caller has already awaited `.json()`. A branch cut before the sweep still
 * declares them, so an export called `responseErrorMessage` here would collide
 * with them at merge, in silence. So both shapes live here and both say which
 * they take:
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
