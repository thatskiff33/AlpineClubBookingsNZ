import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { syncContactsFromXero } from "@/lib/xero";

/**
 * POST /api/admin/xero/sync-contacts
 * Triggers a bulk contact sync from Xero.
 * Matches Xero contacts to local members by email and links xeroContactId.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const result = await syncContactsFromXero();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Contact sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
