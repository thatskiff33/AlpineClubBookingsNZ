import { NextResponse } from "next/server";
import {
  addyAddressIdSchema,
  getAddyAddressSelection,
} from "@/lib/addy-api";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const rateLimited = applyRateLimit(
    rateLimiters.addressAutocomplete,
    request,
  );
  if (rateLimited) return rateLimited;

  const { id } = await context.params;
  const parsedId = addyAddressIdSchema.safeParse(id);

  if (!parsedId.success) {
    return NextResponse.json({ error: "Invalid address id" }, { status: 400 });
  }

  const searchParams = new URL(request.url).searchParams;
  const session = searchParams.get("session") ?? undefined;

  try {
    const result = await getAddyAddressSelection({
      id: parsedId.data,
      session: session?.match(/^[A-Za-z0-9_-]{1,80}$/) ? session : undefined,
    });

    if (!result.configured) {
      return NextResponse.json(
        { error: "Address autocomplete is not configured" },
        { status: 503 },
      );
    }

    return NextResponse.json({ selection: result.selection });
  } catch {
    return NextResponse.json(
      { error: "Address details are unavailable" },
      { status: 502 },
    );
  }
}
