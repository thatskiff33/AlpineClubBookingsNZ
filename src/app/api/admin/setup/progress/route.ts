import { NextRequest, NextResponse } from "next/server";
import { setupProgressSchema } from "@/lib/admin-support-api/system";
import { logAudit } from "@/lib/audit";
import { SETUP_PROGRESS_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-system";
import { connectionJson } from "@/lib/mcp-connection-request";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { normalizeSetupProgress } from "@/lib/setup-readiness";
import type { SetupStepId } from "@/lib/setup-step-ids";
import { parseJsonRequestBody } from "@/lib/api-json";

// The body schema lives in admin-support-api/system.ts, which the AI app
// actions `update_setup_step`, `finish_setup` and `reset_setup_progress`
// offer one branch each of (ALP-724).

function withoutStep(ids: string[], stepId: SetupStepId) {
  return ids.filter((id) => id !== stepId);
}

export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = setupProgressSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.setupProgress.findUnique({
    where: { id: "default" },
  });
  const currentCompleted = existing?.completedStepIds ?? [];
  const currentSkipped = existing?.skippedStepIds ?? [];
  let completedStepIds = currentCompleted;
  let skippedStepIds = currentSkipped;
  let completedAt = existing?.completedAt ?? null;
  let completedByMemberId = existing?.completedByMemberId ?? null;

  switch (parsed.data.action) {
    case "reset":
      completedStepIds = [];
      skippedStepIds = [];
      completedAt = null;
      completedByMemberId = null;
      break;
    case "finish":
      completedAt = new Date();
      completedByMemberId = session.user.id;
      break;
    case "complete":
      completedStepIds = Array.from(
        new Set([...withoutStep(currentCompleted, parsed.data.stepId), parsed.data.stepId]),
      );
      skippedStepIds = withoutStep(currentSkipped, parsed.data.stepId);
      completedAt = null;
      completedByMemberId = null;
      break;
    case "skip":
      completedStepIds = withoutStep(currentCompleted, parsed.data.stepId);
      skippedStepIds = Array.from(
        new Set([...withoutStep(currentSkipped, parsed.data.stepId), parsed.data.stepId]),
      );
      completedAt = null;
      completedByMemberId = null;
      break;
    case "reopen":
      completedStepIds = withoutStep(currentCompleted, parsed.data.stepId);
      skippedStepIds = withoutStep(currentSkipped, parsed.data.stepId);
      completedAt = null;
      completedByMemberId = null;
      break;
  }

  const record = await prisma.setupProgress.upsert({
    where: { id: "default" },
    update: {
      completedStepIds,
      skippedStepIds,
      completedAt,
      completedByMemberId,
    },
    create: {
      id: "default",
      completedStepIds,
      skippedStepIds,
      completedAt,
      completedByMemberId,
    },
  });

  await logAudit({
    action: "setup_progress.update",
    memberId: session.user.id,
    category: "system",
    summary: `Setup progress ${parsed.data.action}`,
    metadata: parsed.data,
  });

  return connectionJson(
    request,
    {
      progress: normalizeSetupProgress({
        completedStepIds: record.completedStepIds,
        skippedStepIds: record.skippedStepIds,
        completedAt: record.completedAt?.toISOString() ?? null,
        completedByMemberId: record.completedByMemberId,
      }),
    },
    SETUP_PROGRESS_CONNECTION_SHAPE,
  );
}
