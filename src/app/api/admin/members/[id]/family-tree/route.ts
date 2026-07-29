import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getMemberFamilyTree } from "@/lib/member-family-tree";

/**
 * GET /api/admin/members/[id]/family-tree
 *
 * Read-only derived family tree for the admin member page's Family card
 * (#2253). Admin-only by owner decision; gated on membership:view — the same
 * permission that already exposes every member's detail page, which is where
 * the data this tree derives from (parent links, dependants, partner links,
 * family groups) is already visible.
 *
 * The tree adds no write surface and NO FIELD BEYOND WHAT `membership:view`
 * ALREADY EXPOSES. Stated that way deliberately: the member page's dependants
 * list happens to omit email while the tree shows it, so the honest comparison
 * is the permission, not one page — `/api/admin/members` returns the same
 * addresses at the same permission. What genuinely changes is convenience and
 * reach (one call assembles a picture an admin previously assembled page by
 * page), which is the owner's decided trade on #2253.
 *
 * Archived members appear with their contact details left off. That is a
 * presentation choice matching the member page's own treatment, not a privacy
 * control — the permission above is the control.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Invalid route parameters" }, { status: 400 });
  }

  const tree = await getMemberFamilyTree(prisma, id);
  if (!tree) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  return NextResponse.json(tree);
}
