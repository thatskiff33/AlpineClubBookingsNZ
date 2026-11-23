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
  | "Invalid JSON."
  | "That post could not be read.";

export type InvalidJsonBodyOptions = { error: InvalidJsonWording };

type JsonRequestBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse };

/**
 * The 400 answer for a request body that is not valid JSON: the default body
 * with its `details`, or, when a route passes its own wording from the closed
 * list, exactly `{ error }`, byte-identical to the inline copy it replaced.
 * Both readers below answer through here, so the answer is defined once.
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

/**
 * Reads a body the route requires. Anything that is not valid JSON, an empty
 * body included, answers the invalid-JSON 400.
 */
export async function parseJsonRequestBody(
  request: Request,
  options?: InvalidJsonBodyOptions,
): Promise<JsonRequestBodyResult> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: invalidJsonBodyResponse(options) };
  }
}

/**
 * Reads a body the route accepts but does not require (#5407). An empty body,
 * or one of only whitespace, means "no body": the result is `ok` with `body`
 * `undefined`, and the route applies its defaults. A body that is present but
 * is not valid JSON answers the same invalid-JSON 400 as
 * `parseJsonRequestBody`, so a malformed body is never mistaken for an absent
 * one.
 *
 * The rule for a route whose body is optional: an empty body or a JSON `null`
 * means "no body". This reader returns `undefined` for the first and `null`
 * for the second, and the routes apply their default with `body ?? default`,
 * which treats both alike. A route that ever needs to tell them apart can,
 * since no JSON value parses to `undefined`.
 */
export async function parseOptionalJsonRequestBody(
  request: Request,
  options?: InvalidJsonBodyOptions,
): Promise<JsonRequestBodyResult> {
  try {
    const text = await request.text();
    return {
      ok: true,
      body: text.trim() === "" ? undefined : (JSON.parse(text) as unknown),
    };
  } catch {
    return { ok: false, response: invalidJsonBodyResponse(options) };
  }
}
