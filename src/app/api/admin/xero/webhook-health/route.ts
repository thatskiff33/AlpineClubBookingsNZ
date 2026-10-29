import { MIN_SILENT_WEBHOOK_HOURS, MAX_SILENT_WEBHOOK_HOURS, silentWebhookHoursSchema } from "@/lib/xero-webhook-policy";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { getXeroWebhookHealth } from "@/lib/xero-webhook-health";

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  return NextResponse.json(await getXeroWebhookHealth());
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  const limit = await checkRateLimit({ id: "xero-webhook-settings", limit: 10, windowSeconds: 60 }, guard.session.user.id);
  if (!limit.success) return rateLimitedResponse(limit);
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const parsed = z.object({ hours: silentWebhookHoursSchema }).safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: `Enter a whole number of hours from ${MIN_SILENT_WEBHOOK_HOURS} to ${MAX_SILENT_WEBHOOK_HOURS}.` }, { status: 400 });
  await prisma.$transaction(async (tx) => {
    await tx.xeroInboundSettings.upsert({ where: { id: "default" }, create: { id: "default", silentWebhookHours: parsed.data.hours }, update: { silentWebhookHours: parsed.data.hours } });
    await createAuditLog({ action: "XERO_WEBHOOK_THRESHOLD_UPDATED", category: "xero", memberId: guard.session.user.id, metadata: { hours: parsed.data.hours } }, tx);
  });
  return NextResponse.json(await getXeroWebhookHealth());
}
