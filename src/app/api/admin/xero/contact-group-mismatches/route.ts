import { NextRequest, NextResponse } from "next/server";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroMemberGroupingSnapshot } from "@/lib/xero-member-grouping-resync";
import {
  resyncXeroContactCachesByIds,
  XeroResyncUnavailableError,
} from "@/lib/xero-mismatch-resync";
import { XeroDailyLimitError } from "@/lib/xero-api-client";
import logger from "@/lib/logger";
import { CONTACT_GROUP_MISMATCH_LIMIT } from "@/lib/xero-contact-group-mismatch-summary";

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
    const snapshot = await getXeroMemberGroupingSnapshot(parsed.data);
    return NextResponse.json(snapshot);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero contact group mismatch snapshot");
    return NextResponse.json(
      { error: "Failed to load Xero contact group mismatch snapshot" },
      { status: 500 }
    );
  }
}

const resyncBodySchema = z.object({
  limit: z.number().int().min(1).max(500).default(CONTACT_GROUP_MISMATCH_LIMIT),
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
    // Uncapped, so the total below covers every flagged contact; the
    // re-sync itself is still capped per kind just after.
    const before = await getXeroMemberGroupingSnapshot();
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
    // managed group in Xero drops off the panel on Refresh. Each list is
    // capped at `limit` (sent, or CONTACT_GROUP_MISMATCH_LIMIT).
    const { limit } = parsed.data;
    const resync = await resyncXeroContactCachesByIds(
      [
        ...before.mismatches.slice(0, limit).map((mismatch) => mismatch.xeroContactId),
        ...before.informational.slice(0, limit).map((entry) => entry.xeroContactId),
      ],
      "adminXeroContactGroupMismatchResync"
    );
    // Distinct contacts across both full lists, counted the same way as
    // `requestedContacts` (members sharing a contact count once), so the
    // panel counts out of the true total and names the full groups refresh
    // for the rest (another Refresh would re-fetch the same first contacts).
    const flaggedContacts = new Set(
      [...before.mismatches, ...before.informational].map((entry) => entry.xeroContactId)
    ).size;
    const snapshot = await getXeroMemberGroupingSnapshot(parsed.data);
    return NextResponse.json({ ...snapshot, resync: { ...resync, flaggedContacts } });
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
