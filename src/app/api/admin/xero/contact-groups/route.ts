import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getXeroContactGroups } from "@/lib/xero";

/**
 * GET /api/admin/xero/contact-groups
 * Returns available Xero contact groups for the import UI.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const groups = await getXeroContactGroups();
    return NextResponse.json({ groups });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch contact groups";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
