import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { hideUnlistedOtherLodge } from "@/lib/other-lodge-hide";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({ id: z.string().min(1) });

// POST /api/admin/other-lodges/:id/hide — hide an Other lodges row the central
// server does not list (#58). The rules are `hideUnlistedOtherLodge`'s; this
// route guards, audits and answers. The audit row names the lodge by id and
// name only: a booking officer's contact is never copied into it.
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

  const result = await hideUnlistedOtherLodge(parsedParams.data.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "OTHER_LODGE_HIDDEN",
      actor: { memberId: guard.session.user.id },
      entity: { type: "OtherLodge", id: result.hidden.id },
      category: "admin",
      severity: "info",
      outcome: "success",
      summary: "Other lodge not found on the Alpine Central Server hidden",
      metadata: { hiddenOtherLodge: result.hidden },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ ok: true });
}
