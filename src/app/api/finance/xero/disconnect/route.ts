import { NextResponse } from "next/server";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import { disconnectFinanceXero } from "@/lib/finance-xero";

export async function POST() {
  const authResult = await requireFinanceManagerApiAccess();

  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    await disconnectFinanceXero();
    return NextResponse.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to disconnect finance Xero";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
