import { NextRequest, NextResponse } from "next/server";
import { adminEligibleFamilyQuerySchema } from "@/lib/admin-bookings-schemas/bookings";
import { ADMIN_MEMBER_FAMILY_CONNECTION_SHAPE } from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { resolveMemberFamily } from "@/lib/resolve-member-family";

/**
 * GET /api/admin/bookings/eligible-family?forMemberId=<id>
 *
 * On-behalf family picker for the CREATE-booking flow. Gated on `bookings:edit`
 * (NOT membership:view): a Booking Officer building a booking for a member can
 * fetch that member's family group to attach member identities and get correct
 * member pricing, even without membership:view (issue #1376, option A).
 *
 * The actor has already selected the member they are booking for, so the
 * client-supplied `forMemberId` names that single member. It returns exactly
 * ONE member's family group per request (via the shared resolveMemberFamily
 * helper) — never a directory enumeration. Also the AI app action
 * `get_member_family_for_booking` (ALP-719).
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const parsed = adminEligibleFamilyQuerySchema.safeParse({
    forMemberId: request.nextUrl.searchParams.get("forMemberId"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "forMemberId is required" },
      { status: 400 },
    );
  }

  const family = await resolveMemberFamily(parsed.data.forMemberId);
  if (!family) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  return connectionJson(request, family, ADMIN_MEMBER_FAMILY_CONNECTION_SHAPE);
}
