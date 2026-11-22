import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroMemberGroupingSnapshot } from "@/lib/xero-member-grouping-resync";
import {
  resyncXeroContactCachesByIds,
  XeroResyncUnavailableError,
} from "@/lib/xero-mismatch-resync";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import logger from "@/lib/logger";
import {
  XERO_CONTACT_GROUP_MISMATCHES_CONNECTION_SHAPE,
  XERO_CONTACT_GROUP_MISMATCHES_RESYNCED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-xero-contacts";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  xeroContactGroupMismatchResyncBodySchema,
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
    const snapshot = await getXeroMemberGroupingSnapshot(parsed.data);
    return connectionJson(request, snapshot, XERO_CONTACT_GROUP_MISMATCHES_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero contact group mismatch snapshot");
    return NextResponse.json(
      { error: "Failed to load Xero contact group mismatch snapshot" },
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
  const parsed = xeroContactGroupMismatchResyncBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const before = await getXeroMemberGroupingSnapshot(parsed.data);
    if (!before.cacheReady) {
      return NextResponse.json(
        {
          error:
            "The shared Xero contact-group cache has never been synced — run the full Xero groups refresh first.",
        },
        { status: 409 }
      );
    }

    // #5234: information-only entries too, so a contact removed from a
    // managed group in Xero drops off the panel on Refresh. Both lists are
    // capped by `limit` (sent, or CONTACT_GROUP_MISMATCH_LIMIT).
    const resync = await resyncXeroContactCachesByIds(
      [
        ...before.mismatches.map((mismatch) => mismatch.xeroContactId),
        ...before.informational.map((entry) => entry.xeroContactId),
      ],
      "adminXeroContactGroupMismatchResync"
    );
    const snapshot = await getXeroMemberGroupingSnapshot(parsed.data);
    return connectionJson(
      request,
      { ...snapshot, resync },
      XERO_CONTACT_GROUP_MISMATCHES_RESYNCED_CONNECTION_SHAPE,
    );
  } catch (error) {
    if (error instanceof XeroResyncUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof XeroDailyLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    logger.error({ err: error }, "Failed to resync Xero contact group mismatches");
    return NextResponse.json(
      { error: "Failed to resync the flagged contacts from Xero" },
      { status: 500 }
    );
  }
}
