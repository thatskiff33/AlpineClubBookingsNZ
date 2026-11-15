import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/session-guards";
import { readUnifiedExceptionQueue } from "@/lib/booking-exception-request-service";
import {
  adminListPageQueryFields,
} from "@/lib/admin-list-page";

const querySchema = z.object({
  status: z
    .enum([
      "REQUESTED",
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "SUPERSEDED",
      // #2553: a request the hold reaper closed. Read-only filter value, kept in
      // step with `ExceptionQueueStatusFilter` so the type and the route cannot
      // disagree — the service advertising a value the route rejects is how an
      // officer screen ends up 400ing on its own "Expired" tab.
      "EXPIRED",
      "ALL",
    ])
    .optional()
    .default("REQUESTED"),
  ...adminListPageQueryFields,
});

/**
 * The unified Booking Officer queue: every policy-exception request, merged from
 * the new-booking table and the POLICY_EXCEPTION BookingChangeRequest rows into
 * one age-ordered `{ data, page, pageSize, total, totalPages }` view. Same guard and
 * envelope as the existing booking-change-request queue.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await readUnifiedExceptionQueue(parsed.data);
  return NextResponse.json(result);
}
