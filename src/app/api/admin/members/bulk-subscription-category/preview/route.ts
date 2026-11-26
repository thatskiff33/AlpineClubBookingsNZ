import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { previewBulkSubscriptionCategory } from "@/lib/bulk-subscription-category-assignments";
import { requireAdmin } from "@/lib/session-guards";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { clubSeasonYear } from "@/lib/financial-year";
import { bulkSubscriptionCategoryPreviewSchema } from "../schema";

/** #5248: preview who a bulk subscription-category change moves. */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const read = await parseJsonRequestBody(request);

  if (!read.ok) return read.response;

  const body = read.body;

  const parsed = bulkSubscriptionCategoryPreviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // ONE read of the club's zone for the whole batch (#2870, #3123): every
  // member's age tier and "still to come" bookings are judged against the same
  // day and season.
  const clubZone = await clubTimeZone();
  const result = await previewBulkSubscriptionCategory({
    ids: parsed.data.ids,
    seasonYear: parsed.data.seasonYear,
    subscriptionCategoryId: parsed.data.subscriptionCategoryId,
    now: dateOnlyInstantOf(clubToday(clubZone)),
    clubCurrentSeasonYear: clubSeasonYear(clubZone),
  });

  return NextResponse.json(result.body, result.init);
}
