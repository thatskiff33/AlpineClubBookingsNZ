import { NextRequest, NextResponse } from "next/server";
import {
  adminMembersQuerySchema,
  createAdminMember,
  createMemberSchema,
  listAdminMembers,
} from "@/lib/admin-members-service";
import { requireAdmin } from "@/lib/session-guards";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

/**
 * GET /api/admin/members
 * List members with search, filtering, sorting, and pagination.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  const parsed = adminMembersQuerySchema.safeParse({
    q: sp.get("q") ?? undefined,
    search: sp.get("search") ?? undefined,
    page: sp.get("page") ?? undefined,
    pageSize: sp.get("pageSize") ?? undefined,
    sortBy: sp.get("sortBy") ?? undefined,
    sortDir: sp.get("sortDir") ?? undefined,
    inheritEmailEligible: sp.get("inheritEmailEligible") ?? undefined,
    excludeId: sp.get("excludeId") ?? undefined,
    dependentLinkEligibleFor: sp.get("dependentLinkEligibleFor") ?? undefined,
    parentLinkEligibleFor: sp.get("parentLinkEligibleFor") ?? undefined,
    partnerLinkEligibleFor: sp.get("partnerLinkEligibleFor") ?? undefined,
    role: sp.get("role") ?? undefined,
    financeAccess: sp.get("financeAccess") ?? undefined,
    lifecycleStatus: sp.get("lifecycleStatus") ?? undefined,
    includeArchived: sp.get("includeArchived") ?? undefined,
    active: sp.get("active") ?? undefined,
    ageTier: sp.get("ageTier") ?? undefined,
    ageTierIn: sp.get("ageTierIn") ?? undefined,
    membershipType: sp.get("membershipType") ?? undefined,
    xeroLinked: sp.get("xeroLinked") ?? undefined,
    inviteStatus: sp.get("inviteStatus") ?? undefined,
    subscription: sp.get("subscription") ?? undefined,
    familyGroup: sp.get("familyGroup") ?? undefined,
    xeroContactGroup: sp.get("xeroContactGroup") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await listAdminMembers(parsed.data);
  return NextResponse.json(result.body, result.init);
}

/**
 * POST /api/admin/members
 * Create a new member.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createMemberSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const result = await createAdminMember(parsed.data, guard.session.user);
  return NextResponse.json(result.body, result.init);
}
