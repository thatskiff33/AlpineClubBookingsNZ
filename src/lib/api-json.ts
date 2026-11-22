import { NextResponse } from "next/server";

/**
 * The one 400 answer for a request body that is not valid JSON. Routes that
 * read the body their own way (for example accepting an empty body) still
 * answer with this, so the wording has one definition.
 */
export function invalidJsonBodyResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "Invalid JSON",
      details: { body: ["Request body must be valid JSON"] },
    },
    { status: 400 },
  );
}

export async function parseJsonRequestBody(request: Request): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse }
> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: invalidJsonBodyResponse() };
  }
}
