import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { createAuditLog } from "@/lib/audit";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import {
  syncMemberFromXeroNow, syncBookingFromXeroNow, syncClubFromXeroNow, XeroSyncNowError,
} from "@/lib/xero-sync-now";

const requestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("member"), id: z.string().min(1).max(128) }),
  z.object({ scope: z.literal("booking"), id: z.string().min(1).max(128) }),
  z.object({ scope: z.literal("club") }),
]);
const limiter = { id: "xero-sync-now", limit: 3, windowSeconds: 60 };

export async function POST(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const limit = await checkRateLimit(limiter, guard.session.user.id);
  if (!limit.success) return rateLimitedResponse(limit);
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Choose a member, booking or whole-club sync." }, { status: 400 });
  const scope = parsed.data;
  const targetId = "id" in scope ? scope.id : undefined;
  const entityType = scope.scope === "member" ? "Member" : scope.scope === "booking" ? "Booking" : "Xero";
  const entityId = targetId ?? "club";
  try {
    const result = scope.scope === "member" ? await syncMemberFromXeroNow(scope.id)
      : scope.scope === "booking" ? await syncBookingFromXeroNow(scope.id)
      : await syncClubFromXeroNow();
    await createAuditLog({
      action: "XERO_SYNC_NOW", category: "xero", memberId: guard.session.user.id,
      targetId, entityType, entityId, summary: result.message, metadata: { scope: scope.scope },
    });
    return NextResponse.json(result);
  } catch (error) {
    const info = getXeroApiErrorInfo(error, "Sync could not finish. Some records may have updated; it is safe to retry.");
    const message = error instanceof XeroSyncNowError ? error.message : info.clientMessage;
    await createAuditLog({
      action: "XERO_SYNC_NOW", category: "xero", memberId: guard.session.user.id,
      targetId, entityType, entityId, outcome: "failure", summary: message, metadata: { scope: scope.scope },
    });
    return NextResponse.json({ error: message }, { status: error instanceof XeroSyncNowError ? error.status : info.handled ? info.status : 500 });
  }
}
