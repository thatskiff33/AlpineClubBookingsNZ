import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findDuplicateContacts } from "@/lib/xero";

/**
 * GET /api/admin/xero/duplicate-contacts
 * Scans Xero contacts for duplicate emails and returns grouped results
 * with invoice counts and deep links for manual merging in Xero UI.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const result = await findDuplicateContacts();
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Duplicate scan failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
