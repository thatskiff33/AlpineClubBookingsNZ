import { NextRequest, NextResponse } from "next/server";
import {
  familyGroupMemberSearchQuerySchema,
  searchFamilyGroupCandidateMembers,
} from "@/lib/admin-family-group-member-search";
import { requireAdmin } from "@/lib/session-guards";
import { connectionJson } from "@/lib/mcp-connection-request";
import { FAMILY_GROUP_MEMBER_SEARCH_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-family-groups";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * GET /api/admin/family-groups/member-search
 *
 * Candidate member records for the identity-sensitive Family Group workflows
 * (#2568): linking an existing member, choosing between suggested matches,
 * deciding create-versus-link, and confirming a selection. Each row carries the
 * server-calculated AGE and no date of birth.
 *
 * The membership-view permission is re-checked here on every request, server
 * side, against the roles read from the database — an administrator whose role
 * covers an unrelated area gets a 401 and no identity information at all.
 *
 * An AI app connection is sent no age and no sign-in field, and each parent
 * link as an id, a name and the link type only (ALP-720).
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    forbiddenResponse: unauthorizedResponse,
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  const parsed = familyGroupMemberSearchQuerySchema.safeParse({
    q: sp.get("q") ?? undefined,
    ageTierIn: sp.get("ageTierIn") ?? undefined,
    prospectiveParentMemberId:
      sp.get("prospectiveParentMemberId") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await searchFamilyGroupCandidateMembers(parsed.data);
  return connectionJson(req, result, FAMILY_GROUP_MEMBER_SEARCH_CONNECTION_SHAPE);
}
