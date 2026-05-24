import { NextRequest, NextResponse } from "next/server";
import { AdminCreditAdjustmentRequestStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getAdminAdjustmentRequests } from "@/lib/member-credit";

const allowedStatuses = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "ALL",
] as const);

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { searchParams } = new URL(request.url);
  const requestedStatus = (searchParams.get("status") ?? "PENDING").toUpperCase();
  const status = allowedStatuses.has(
    requestedStatus as "PENDING" | "APPROVED" | "REJECTED" | "ALL"
  )
    ? (requestedStatus as
        | AdminCreditAdjustmentRequestStatus
        | "ALL")
    : AdminCreditAdjustmentRequestStatus.PENDING;

  const requests = await getAdminAdjustmentRequests(status);

  return NextResponse.json(requests);
}
