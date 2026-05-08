import { NextRequest, NextResponse } from "next/server";
import { validateGuestChoreToken } from "@/lib/guest-chore-token";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * GET /api/chores/[token]
 * Public endpoint. Validates guest chore token and returns assignments.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.guestChoreToken, req);
  if (rateLimited) {
    return rateLimited;
  }

  const { token } = await params;

  const result = await validateGuestChoreToken(token);
  if (!result) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    date: result.date.toISOString().split("T")[0],
    guest: result.guest,
    assignments: result.assignments,
  });
}

/**
 * PUT /api/chores/[token]
 * Guest chore links are read-only. Chore completion must use the authenticated
 * lodge roster endpoint, backed by revocable session or PIN state.
 */
export async function PUT() {
  return NextResponse.json(
    { error: "Guest chore links are read-only. Use the lodge roster to update chore completion." },
    { status: 405, headers: { Allow: "GET" } }
  );
}
