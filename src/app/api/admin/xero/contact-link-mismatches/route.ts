import { NextRequest, NextResponse } from "next/server";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroContactLinkMismatchSnapshot } from "@/lib/xero-contact-link-mismatches";
import {
  resyncXeroContactCachesByIds,
  XeroResyncUnavailableError,
} from "@/lib/xero-mismatch-resync";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import logger from "@/lib/logger";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse({
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
    return NextResponse.json(snapshot);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero contact link mismatch snapshot");
    return NextResponse.json(
      { error: "Failed to load Xero contact link mismatch snapshot" },
      { status: 500 }
    );
  }
}

const resyncBodySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

// Resync-from-Xero (#1441): re-fetch the currently flagged contacts from
// Xero, rewrite their cache rows, then recompute. Page load stays the cached
// GET above; only the panel's Refresh button pays a Xero call.
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const jsonBody = await parseOptionalJsonRequestBody(request, { whenAbsent: {} });
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = resyncBodySchema.safeParse(jsonBody.body);
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
    return NextResponse.json({ ...snapshot, resync });
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
