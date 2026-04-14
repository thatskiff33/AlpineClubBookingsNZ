import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { syncContactsFromXero } from "@/lib/xero";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import logger from "@/lib/logger";

const syncContactsSchema = z.object({
  fullResync: z.boolean().optional(),
  backfillJoinedDates: z.boolean().optional(),
});

/**
 * POST /api/admin/xero/sync-contacts
 * Triggers an incremental contact sync from Xero by default.
 * Accepts optional JSON repair flags for explicit full rescans/backfills.
 * Matches Xero contacts to local members by email and links xeroContactId.
 * Returns a detailed SyncReport with categorized results.
 */
export async function POST(request?: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let options: z.infer<typeof syncContactsSchema> = {};
  const contentType = request?.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await request?.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const parsed = syncContactsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 422 }
      );
    }
    options = parsed.data;
  }

  try {
    const report = await syncContactsFromXero(options);
    return NextResponse.json({ syncReport: report });
  } catch (error) {
    const xeroError = getXeroApiErrorInfo(error, "Contact sync failed");
    if (!xeroError.handled) {
      logger.error({ err: error }, "Failed to sync contacts from Xero");
    }
    return NextResponse.json({ error: xeroError.message }, { status: xeroError.status });
  }
}
