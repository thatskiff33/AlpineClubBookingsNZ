import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { removeUnlistedOtherLodge } from "@/lib/other-lodge-removal";
import { serializeOtherLodge } from "@/lib/other-lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({ id: z.string().min(1) });

// POST /api/admin/other-lodges/:id/remove — remove an Other lodges row the
// central server does not list and nothing here refers to (#58). The rules are
// `removeUnlistedOtherLodge`'s; this route guards, audits and answers.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid lodge id" }, { status: 400 });
  }

  const result = await removeUnlistedOtherLodge(parsedParams.data.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "OTHER_LODGE_REMOVED",
      actor: { memberId: guard.session.user.id },
      entity: { type: "OtherLodge", id: result.removed.id },
      category: "admin",
      severity: "info",
      outcome: "success",
      summary: "Other lodge not found on the Alpine Central Server removed",
      metadata: { removedOtherLodge: serializeOtherLodge(result.removed) },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ ok: true });
}
