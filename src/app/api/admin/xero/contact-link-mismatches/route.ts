import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroContactLinkMismatchSnapshot } from "@/lib/xero-contact-link-mismatches";
import {
  resyncXeroContactCachesByIds,
  XeroResyncUnavailableError,
} from "@/lib/xero-mismatch-resync";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import logger from "@/lib/logger";
import {
  XERO_CONTACT_LINK_MISMATCHES_CONNECTION_SHAPE,
  XERO_CONTACT_LINK_MISMATCHES_RESYNCED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-xero-contacts";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  xeroContactLinkMismatchResyncBodySchema,
  xeroContactMismatchQuerySchema,
} from "@/lib/xero-contact-review-requests";

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = xeroContactMismatchQuerySchema.safeParse({
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const snapshot = await getXeroContactLinkMismatchSnapshot(parsed.data);
    return connectionJson(request, snapshot, XERO_CONTACT_LINK_MISMATCHES_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero contact link mismatch snapshot");
    return NextResponse.json(
      { error: "Failed to load Xero contact link mismatch snapshot" },
      { status: 500 }
    );
  }
}

// Resync-from-Xero (#1441): re-fetch the currently flagged contacts from
// Xero, rewrite their cache rows, then recompute. Page load stays the cached
// GET above; only the panel's Refresh button pays a Xero call.
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => ({}));
  const parsed = xeroContactLinkMismatchResyncBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const before = await getXeroContactLinkMismatchSnapshot(parsed.data);
    if (!before.cacheReady) {
      return NextResponse.json(
        {
          error:
            "The shared Xero contact cache has never been synced — run the full Xero contacts refresh first.",
        },
        { status: 409 }
      );
    }

    const resync = await resyncXeroContactCachesByIds(
      before.mismatches.map((mismatch) => mismatch.xeroContactId),
      "adminXeroContactLinkMismatchResync"
    );
    const snapshot = await getXeroContactLinkMismatchSnapshot(parsed.data);
    return connectionJson(
      request,
      { ...snapshot, resync },
      XERO_CONTACT_LINK_MISMATCHES_RESYNCED_CONNECTION_SHAPE,
    );
  } catch (error) {
    if (error instanceof XeroResyncUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof XeroDailyLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    logger.error({ err: error }, "Failed to resync Xero contact link mismatches");
    return NextResponse.json(
      { error: "Failed to resync the flagged contacts from Xero" },
      { status: 500 }
    );
  }
}
