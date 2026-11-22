import { NextResponse } from "next/server";

/**
 * A caller's own wording for the invalid-JSON 400. The body is exactly
 * `{ error }`, with `details` only when given, so a route that has always
 * answered `{ error: "Invalid JSON payload" }` keeps those bytes. A route
 * that wants the standard answer passes nothing.
 */
export type InvalidJsonBodyOptions = {
  error: string;
  details?: Record<string, string[]>;
};

/**
 * The one 400 answer for a request body that is not valid JSON. Routes that
 * read the body their own way (for example accepting an empty body) still
 * answer with this, so the wording has one definition.
 */
export function invalidJsonBodyResponse(
  options?: InvalidJsonBodyOptions,
): NextResponse {
  return NextResponse.json(
    options ?? {
      error: "Invalid JSON",
      details: { body: ["Request body must be valid JSON"] },
    },
    { status: 400 },
  );
}

export async function parseJsonRequestBody(
  request: Request,
  options?: InvalidJsonBodyOptions,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse }
> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: invalidJsonBodyResponse(options) };
  }
}
