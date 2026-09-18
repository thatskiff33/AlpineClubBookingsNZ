import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
} from "@/lib/setup-readiness";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const [database, progressRecord] = await Promise.all([
    getSetupDatabaseSnapshot(),
    prisma.setupProgress.findUnique({ where: { id: "default" } }),
  ]);
  const progress = normalizeSetupProgress(
    progressRecord
      ? {
          completedStepIds: progressRecord.completedStepIds,
          skippedStepIds: progressRecord.skippedStepIds,
          completedAt: progressRecord.completedAt?.toISOString() ?? null,
          completedByMemberId: progressRecord.completedByMemberId,
        }
      : null,
  );

  return NextResponse.json({
    readiness: buildSetupReadiness({
      database,
      progress,
    }),
    progress,
  });
}
