/**
 * The one way an admin surface turns a failed `fetch` into a message a person
 * can read (#2931).
 *
 * Three sections had each grown their own copy of this, and the fourth caller
 * is what made it a single-source-of-truth problem rather than a coincidence
 * (`INV-SSOT`). The rule the copies shared, and that this module now owns:
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
 */
export async function responseErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | null;
  const error = typeof body?.error === "string" ? body.error.trim() : "";
  return error === "" ? fallback : error;
}
