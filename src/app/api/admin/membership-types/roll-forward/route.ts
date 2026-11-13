import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuditRequestContext } from "@/lib/audit";
import { rollForwardSeasonalMembershipAssignments } from "@/lib/seasonal-membership-assignments";
import { requireAdmin } from "@/lib/session-guards";
import { transactionContendedResponse } from "@/lib/transaction-contended-response";

const rollForwardSchema = z
  .object({
    fromSeasonYear: z.number().int().min(2020).max(2040),
    toSeasonYear: z.number().int().min(2020).max(2040),
    dryRun: z.boolean().optional().default(false),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedBody = rollForwardSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof rollForwardSeasonalMembershipAssignments>>;
  try {
    result = await rollForwardSeasonalMembershipAssignments({
      fromSeasonYear: parsedBody.data.fromSeasonYear,
      toSeasonYear: parsedBody.data.toSeasonYear,
      dryRun: parsedBody.data.dryRun,
      adminMemberId: guard.session.user.id,
      request: getAuditRequestContext(request),
    });
  } catch (err) {
    // INV-LOCK-005: only the copy transaction (the first write) can surface
    // contention; the later lock(1) reconcile chunks are isolated and logged.
    const contended = transactionContendedResponse(
      err,
      "Membership roll-forward contended for a transaction budget",
      {
        context: {
          fromSeasonYear: parsedBody.data.fromSeasonYear,
          toSeasonYear: parsedBody.data.toSeasonYear,
        },
      },
    );
    if (contended) return contended;
    throw err;
  }

  return NextResponse.json(result.body, result.init);
}
