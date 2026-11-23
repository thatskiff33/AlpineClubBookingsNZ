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

export type OptionalJsonBodyOptions = Partial<InvalidJsonBodyOptions> & {
  /** The body the route uses when none was sent. */
  whenAbsent?: unknown;
  /**
   * Set by a route with no schema of its own to refuse a body that parsed but
   * is not a JSON object (`null`, an array, a string, a number, a boolean).
   */
  objectOnly?: boolean;
};

// JSON's own insignificant whitespace (RFC 8259): space, tab, CR, LF. Not
// `trim()`, which also strips no-break and line-separator characters.
const JSON_WHITESPACE_ONLY = /^[ \t\r\n]*$/;

/**
 * Reads a body the route accepts but does not require (#5407). The rule: only
 * an absent body means "use the defaults". A body that is empty or JSON
 * whitespace only is absent, and the result is `ok` with `body` set to
 * `options.whenAbsent` (`undefined` when not given). Anything else is a body
 * that was sent: valid JSON is returned as parsed, `null` included, so a
 * route's schema answers a `null` or other non-object body as it would any
 * other wrong shape, and never runs its default action for it; with
 * `objectOnly`, this reader answers such a body itself. A body that is not
 * valid JSON answers the same invalid-JSON 400 as `parseJsonRequestBody`.
 * The request is decoded as UTF-8, which drops a leading byte-order mark.
 */
export async function parseOptionalJsonRequestBody(
  request: Request,
  options: OptionalJsonBodyOptions = {},
): Promise<JsonRequestBodyResult> {
  let body: unknown;
  try {
    const text = await request.text();
    if (JSON_WHITESPACE_ONLY.test(text)) return { ok: true, body: options.whenAbsent };
    body = JSON.parse(text) as unknown;
  } catch {
    return {
      ok: false,
      response: invalidJsonBodyResponse(options.error ? { error: options.error } : undefined),
    };
  }
  if (options.objectOnly && (typeof body !== "object" || body === null || Array.isArray(body))) {
    return { ok: false, response: nonObjectJsonBodyResponse() };
  }
  return { ok: true, body };
}

/**
 * The 400 for an optional body that parsed but is not a JSON object, on a
 * route that reads its fields without a schema (`objectOnly` above).
 */
function nonObjectJsonBodyResponse(): NextResponse {
  return NextResponse.json(
    { error: "Invalid request body", details: { body: ["Request body must be a JSON object"] } },
    { status: 400 },
  );
}
