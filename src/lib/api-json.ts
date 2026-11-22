import { NextResponse } from "next/server";

/**
 * The wordings an invalid-JSON 400 may carry besides the default. Each is a
 * route's own text from before the shared reader existed, kept so that route
 * answers with the same bytes. A new route does not add one: it uses the
 * default.
 */
type InvalidJsonWording =
  | "Invalid JSON"
  | "Invalid JSON payload"
  | "Invalid JSON.";

export type InvalidJsonBodyOptions = { error: InvalidJsonWording };

/**
 * The 400 answer for a request body that is not valid JSON: the default body
 * with its `details`, or, when a route passes its own wording from the closed
 * list, exactly `{ error }`, byte-identical to the inline copy it replaced.
 * Routes that read the body their own way (for example accepting an empty
 * body) still answer through here.
 */
export function invalidJsonBodyResponse(
  options?: InvalidJsonBodyOptions,
): NextResponse {
  return NextResponse.json(
    options
      ? // Built explicitly so an options object carrying extra fields cannot leak them.
        { error: options.error }
      : {
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
