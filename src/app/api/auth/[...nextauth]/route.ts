import { handlers } from "@/lib/auth";
import { NextRequest } from "next/server";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

export const { GET } = handlers;

export async function POST(request: NextRequest) {
  const rateLimitResponse = applyRateLimit(rateLimiters.login, request);
  if (rateLimitResponse) return rateLimitResponse;

  return handlers.POST(request);
}
