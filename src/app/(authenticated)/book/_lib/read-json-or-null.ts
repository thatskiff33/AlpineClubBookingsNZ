/**
 * Read a reply's JSON object body without throwing (#4942).
 *
 * A gateway's "502 Bad Gateway" page, a truncated body or a bare `null` is not
 * the JSON object the booking routes answer with, and `res.json()` throws on
 * the first two. The wizard's handlers used to await it unguarded, so the throw
 * skipped the line that cleared their busy flag and the button froze.
 *
 * `null` means "the client cannot see what the server said". For a write that
 * is an unknown outcome, not a refusal: the caller says so with
 * `unverifiedWriteMessage` rather than reading it as "nothing happened".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the routes' bodies are read field by field, exactly as `res.json()` was
export async function readJsonOrNull(res: Response): Promise<Record<string, any> | null> {
  try {
    const body: unknown = await res.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
