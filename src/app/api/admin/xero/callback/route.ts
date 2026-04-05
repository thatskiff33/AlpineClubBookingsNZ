import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { handleXeroCallback } from "@/lib/xero";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/callback
 * Handles the OAuth2 callback from Xero after admin grants consent.
 */
export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXTAUTH_URL || request.url;

  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/login", baseUrl));
  }

  try {
    // Reconstruct the callback URL using the public base URL so the host
    // matches the registered redirect URI (inside Docker, request.url
    // resolves to the container's internal address like 0.0.0.0:3000).
    const incomingUrl = new URL(request.url);
    const publicCallbackUrl = new URL(incomingUrl.pathname + incomingUrl.search, baseUrl).toString();
    logger.info({ publicCallbackUrl }, "Processing Xero OAuth callback");
    await handleXeroCallback(publicCallbackUrl);
    return NextResponse.redirect(new URL("/admin/xero?connected=true", baseUrl));
  } catch (error) {
    logger.error({ err: error }, "Xero callback error");
    const message = error instanceof Error ? error.message : String(error ?? "Xero connection failed");
    return NextResponse.redirect(
      new URL(`/admin/xero?error=${encodeURIComponent(message)}`, baseUrl)
    );
  }
}
