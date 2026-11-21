import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { createAuditLog } from "@/lib/audit";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import {
  listXeroCashCreditQueue,
  refreshXeroCashCredits,
  XeroCashCreditReadError,
} from "@/lib/xero-cash-credits";

// #5204: the finance queue of unallocated Xero overpayments and prepayments.
// Reading it is finance:view and touches no provider; Refresh reads Xero and is
// finance:edit, like the other officer-run Xero reads.
const limiter = { id: "xero-cash-credits-refresh-post", limit: 3, windowSeconds: 60 };

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  return NextResponse.json(await listXeroCashCreditQueue());
}

export async function POST() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const limit = await checkRateLimit(limiter, guard.session.user.id);
  if (!limit.success) return rateLimitedResponse(limit);
  let result: Awaited<ReturnType<typeof refreshXeroCashCredits>>;
  try {
    result = await refreshXeroCashCredits();
  } catch (error) {
    const info = getXeroApiErrorInfo(error, "Xero could not be read. Nothing was changed; it is safe to try again.");
    const message = error instanceof XeroCashCreditReadError ? error.message : info.clientMessage;
    await createAuditLog({
      action: "XERO_CASH_CREDITS_REFRESH", category: "xero", memberId: guard.session.user.id,
      entityType: "Xero", entityId: "cash-credits", outcome: "failure", summary: message,
    });
    return NextResponse.json({ error: message }, { status: error instanceof XeroCashCreditReadError ? 502 : info.handled ? info.status : 500 });
  }
  // Saved from here on: a later fault is never reported as "nothing was changed".
  await createAuditLog({
    action: "XERO_CASH_CREDITS_REFRESH", category: "xero", memberId: guard.session.user.id,
    entityType: "Xero", entityId: "cash-credits",
    summary: result.current
      ? `Refreshed ${result.open} open Xero overpayment(s) and prepayment(s).`
      : "A refresh that started later had already been saved; nothing was changed.",
    metadata: { ...result },
  });
  return NextResponse.json({ result, queue: await listXeroCashCreditQueue() });
}
