import { NextResponse } from "next/server";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import { getFinanceXeroRouteStatus } from "@/lib/finance-xero";

export async function GET() {
  const authResult = await requireFinanceManagerApiAccess();

  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const status = await getFinanceXeroRouteStatus();
    return NextResponse.json(status);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to check finance Xero status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
