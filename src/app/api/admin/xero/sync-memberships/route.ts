import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { refreshAllMembershipStatuses } from "@/lib/xero";

/**
 * POST /api/admin/xero/sync-memberships
 * Triggers a membership status refresh for all active members with Xero contacts.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const result = await refreshAllMembershipStatuses();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Membership sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
