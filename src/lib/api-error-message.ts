/**
 * Reading a failed API response the way an admin surface needs it (#2931): the
 * sentence to show, and the machine-readable code that says WHICH refusal it
 * was.
 *
 * ## Why this module exists
 *
 * Every admin surface that writes through `fetch` has to turn a non-OK reply
 * into a message, and the rule is always the same. #2931 wrote this one home
 * and measured that **21 private function-shaped copies** of the rule survived
 * across `src/`, and that they had drifted. Measured copy by copy at #3445's
 * review: twelve checked the message was text and nine did not, so on nine an
 * object rendered as `[object Object]`; five used `?? fallback` and eleven
 * returned the value bare, and both of those shapes render an EMPTY red alert
 * on a blank message; three fell back correctly. #3445 converged all
 * twenty-one, plus eight inline `body?.error ?? "…"` sites in four of the
 * same files, so that no screen answers the question two ways.
 *
 * ## What the census guarantees, exactly
 *
 * `api-error-message-census.test.ts` asserts that **no private
 * function-shaped copy exists** outside this file — a small named function
 * that reads `error` and returns a `fallback` — failing closed, so a
 * twenty-second such function is reported with its path. It does NOT count the
 * inline form, `body?.error ?? "sentence"` written straight into a handler,
 * and that form survives tree-wide in the hundreds beyond the four files
 * above. Sweeping those is a filed follow-up; until it lands, an inline read
 * is a screen the settled answers below do not yet cover.
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
 * Four surfaces EXTEND the rule. Each hands the sentence itself to
 * {@link apiErrorMessageFromBody} and keeps only its extension, so the two
 * answers above hold there too:
 *
 *  - `src/app/(admin)/admin/finance/xero/_components/api.ts` — the Xero routes
 *    sometimes answer with a `message` key rather than `error`; that second key
 *    is read once and handed to the shared rule as the fallback.
 *  - `src/components/admin/email-settings/email-message-settings-panel.tsx` —
 *    prefers a validation error's issue list, joined onto the headline (#2267);
 *    the headline is the shared rule's sentence.
 *  - `src/lib/admin-member-xero-actions.ts` — returns an error OBJECT carrying
 *    recovery hints beside the sentence; the sentence is the shared rule's.
 *  - `src/components/admin/finance-report-mappings-panel.tsx` — the save
 *    handler appends the route's `details` list to the shared sentence, so an
 *    officer sees which mapping was refused and not only that one was.
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
 *    reads as a UI bug rather than as a refusal; the fallback is better.
 *    Sixteen of the copies converged here rendered the blank, five through
 *    `?? fallback` and eleven by returning the value bare.
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
 *
 * ## Reading a reply the handler decides about itself (#4976, ALP-589)
 *
 * A handler that throws a refusal into its own `catch`, or that reads one body
 * to decide between success and failure, uses the rest of this file's exports,
 * all built on the two readers above (no second parser):
 *
 *  - {@link readApiErrorBody}: a reply's body, parsed once, `null` when it is
 *    not JSON. Parse once, then hand the result to the `FromBody` functions: a
 *    `Response` body can be read only once.
 *  - {@link readApiObjectOrNull}: that body when it is a JSON object, else
 *    `null`. A write that gets `null` cannot see what the server said.
 *  - {@link readApiObjectOrEmpty}: the same, with `{}` for `null`, so a
 *    success body can be read field by field without a throw. The one home of
 *    the rule "an unreadable or non-object body counts as empty".
 *  - {@link apiRefusalFromResponse} and {@link refusalMessageOr}: a typed throw
 *    and its matching catch, so only a refusal's own sentence reaches the
 *    screen and a dropped connection shows the screen's fallback.
 *  - {@link wordedForbiddenRefusal}: whether a 403 carries a sentence worth
 *    keeping, or only the bare word a screen replaces with its own copy.
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

/** A parsed body that is a JSON object, or `null` for anything else. */
export function jsonObjectOrNull(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function errorObject(body: unknown): { error?: unknown; code?: unknown } | null {
  return jsonObjectOrNull(body);
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
 * Parse a reply's body once, safely: `null` when it is not JSON.
 *
 * A `Response` body can only be read once, so a caller that needs both the code
 * and the message must parse here and then use the `FromBody` functions — not
 * call {@link apiErrorMessageFromResponse} and then try to read the body again.
 */
export async function readApiErrorBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/** A reply's body when it is a JSON object, else `null` (see {@link readApiErrorBody}). */
export async function readApiObjectOrNull(
  response: Response,
): Promise<Record<string, unknown> | null> {
  return jsonObjectOrNull(await readApiErrorBody(response));
}

/** A reply's body when it is a JSON object, else `{}`: never throws, never `null`. */
export async function readApiObjectOrEmpty(response: Response): Promise<Record<string, unknown>> {
  return (await readApiObjectOrNull(response)) ?? {};
}

/** The sentence to show, for a caller that needs nothing but the sentence. */
export async function apiErrorMessageFromResponse(
  response: Response,
  fallback: string,
): Promise<string> {
  return apiErrorMessageFromBody(await readApiErrorBody(response), fallback);
}

/**
 * A refusal read from a failed response, for a handler that throws it into its
 * own `catch` (#4976, ALP-589).
 *
 * That catch also sees a request that never got an answer (`TypeError: Failed
 * to fetch`) and any bug in the success path. Showing `err.message` for those
 * puts the browser's words, or a JSON parse error, in front of the officer;
 * {@link refusalMessageOr} shows the route's sentence only for this class and
 * the screen's own fallback for everything else.
 */
export class ApiRefusalError extends Error {}

/** Read a failed response into an {@link ApiRefusalError} to throw. */
export async function apiRefusalFromResponse(
  response: Response,
  fallback: string,
): Promise<ApiRefusalError> {
  return new ApiRefusalError(await apiErrorMessageFromResponse(response, fallback));
}

/**
 * The bare word `requireAdmin` answers a plain permission refusal with
 * (`forbiddenResponse` in `src/lib/session-guards.ts`).
 */
const BARE_FORBIDDEN_ERROR = "Forbidden";

/**
 * A 403's own worded refusal, or `null` when it says nothing better than the
 * bare word "Forbidden" (or nothing readable, such as a proxy's HTML page).
 *
 * The bare word is the ONE 403 body worth replacing with a screen's own
 * permission copy: the guard's other 403s — "Two-factor verification
 * required", "Password change required", "Account is deactivated" — are
 * curated, specific and actionable, and overwriting them with a generic
 * sentence about roles would be a wrong diagnosis.
 */
export function wordedForbiddenRefusal(body: unknown): ApiRefusalError | null {
  const message = apiErrorMessageFromBody(body, BARE_FORBIDDEN_ERROR);
  return message === BARE_FORBIDDEN_ERROR ? null : new ApiRefusalError(message);
}

/** The sentence for a caught error: a refusal's own, otherwise `fallback`. */
export function refusalMessageOr(err: unknown, fallback: string): string {
  return err instanceof ApiRefusalError ? err.message : fallback;
}
