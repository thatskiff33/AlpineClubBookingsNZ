/**
 * #4987: Communications recipient preview.
 * GET /api/admin/communications/preview?recipientFilter=&category=[&memberId=…]
 * Membership view: it only reads. Returns how many members a send would reach
 * and how many the category's preference rule excludes — counts only, never
 * addresses. It resolves recipients exactly as the send route does.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import {
  bulkEmailCategorySchema,
  communicationRecipientCounts,
  communicationRecipientFilterSchema,
  resolveCommunicationRecipients,
} from "@/lib/communications-recipients";

const querySchema = z.object({
  recipientFilter: communicationRecipientFilterSchema,
  category: bulkEmailCategorySchema,
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    recipientFilter: searchParams.get("recipientFilter"),
    category: searchParams.get("category"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const resolved = await resolveCommunicationRecipients({
    ...parsed.data,
    memberIds: searchParams.getAll("memberId"),
  });
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  return NextResponse.json(
    communicationRecipientCounts(resolved.total, resolved.partition),
  );
}
