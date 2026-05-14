import { NextResponse } from "next/server";
import {
  addySearchQuerySchema,
  searchAddyAddresses,
} from "@/lib/addy-api";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const rateLimited = applyRateLimit(
    rateLimiters.addressAutocomplete,
    request,
  );
  if (rateLimited) return rateLimited;

  const searchParams = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = addySearchQuerySchema.safeParse(searchParams);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid search query" }, { status: 400 });
  }

  try {
    const result = await searchAddyAddresses(parsed.data);

    if (!result.configured) {
      return NextResponse.json(
        { error: "Address autocomplete is not configured" },
        { status: 503 },
      );
    }

    return NextResponse.json({ suggestions: result.suggestions });
  } catch {
    return NextResponse.json(
      { error: "Address search is unavailable" },
      { status: 502 },
    );
  }
}
