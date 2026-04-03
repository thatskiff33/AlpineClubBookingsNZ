import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { handleXeroCallback } from "@/lib/xero";

/**
 * GET /api/admin/xero/callback
 * Handles the OAuth2 callback from Xero after admin grants consent.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    // Pass the full callback URL (includes code and state params)
    await handleXeroCallback(request.url);
    return NextResponse.redirect(new URL("/admin/xero?connected=true", request.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Xero connection failed";
    console.error("Xero callback error:", message);
    return NextResponse.redirect(
      new URL(`/admin/xero?error=${encodeURIComponent(message)}`, request.url)
    );
  }
}
