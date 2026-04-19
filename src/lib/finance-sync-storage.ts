import {
  FinanceSnapshotType,
  FinanceSyncRunStatus,
  FinanceSyncRunTrigger,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const DEFAULT_FINANCE_SNAPSHOT_SCOPE = "default";

export interface CreateFinanceSyncRunInput {
  workflow: string;
  trigger: FinanceSyncRunTrigger;
  startedAt?: Date;
  xeroTenantId?: string | null;
  requestedByMemberId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface CompleteFinanceSyncRunInput {
  runId: string;
  status?: FinanceSyncRunStatus;
  completedAt?: Date;
  snapshotCount?: number;
  totalRowCount?: number;
  resultSummary?: Prisma.InputJsonValue;
  errorSummary?: string | null;
}

export interface FailFinanceSyncRunInput {
  runId: string;
  completedAt?: Date;
  errorSummary: string;
  errorDetails?: Prisma.InputJsonValue;
  snapshotCount?: number;
  totalRowCount?: number;
}

export interface UpsertFinanceSnapshotInput {
  snapshotType: FinanceSnapshotType;
  asOfDate: Date;
  rowCount: number;
  payload: Prisma.InputJsonValue;
  scope?: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  currency?: string | null;
  sourceUpdatedAt?: Date | null;
  syncRunId?: string | null;
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }

  return trimmed;
}

function normalizeOptionalText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertNonNegativeCount(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}

export async function createFinanceSyncRun(input: CreateFinanceSyncRunInput) {
  const workflow = normalizeRequiredText(input.workflow, "workflow");

  return prisma.financeSyncRun.create({
    data: {
      workflow,
      trigger: input.trigger,
      status: FinanceSyncRunStatus.RUNNING,
      startedAt: input.startedAt ?? new Date(),
      xeroTenantId: normalizeOptionalText(input.xeroTenantId),
      requestedByMemberId: normalizeOptionalText(input.requestedByMemberId),
      metadata: input.metadata,
    },
  });
}

export async function completeFinanceSyncRun(input: CompleteFinanceSyncRunInput) {
  const status = input.status ?? FinanceSyncRunStatus.SUCCEEDED;

  if (
    status !== FinanceSyncRunStatus.SUCCEEDED &&
    status !== FinanceSyncRunStatus.PARTIAL
  ) {
    throw new Error("completeFinanceSyncRun only accepts SUCCEEDED or PARTIAL");
  }

  if (input.snapshotCount !== undefined) {
    assertNonNegativeCount(input.snapshotCount, "snapshotCount");
  }
  if (input.totalRowCount !== undefined) {
    assertNonNegativeCount(input.totalRowCount, "totalRowCount");
  }

  return prisma.financeSyncRun.update({
    where: { id: input.runId },
    data: {
      status,
      completedAt: input.completedAt ?? new Date(),
      snapshotCount: input.snapshotCount,
      totalRowCount: input.totalRowCount,
      resultSummary: input.resultSummary,
      errorSummary: normalizeOptionalText(input.errorSummary),
    },
  });
}

export async function failFinanceSyncRun(input: FailFinanceSyncRunInput) {
  if (input.snapshotCount !== undefined) {
    assertNonNegativeCount(input.snapshotCount, "snapshotCount");
  }
  if (input.totalRowCount !== undefined) {
    assertNonNegativeCount(input.totalRowCount, "totalRowCount");
  }

  const errorSummary = normalizeRequiredText(input.errorSummary, "errorSummary");

  return prisma.financeSyncRun.update({
    where: { id: input.runId },
    data: {
      status: FinanceSyncRunStatus.FAILED,
      completedAt: input.completedAt ?? new Date(),
      snapshotCount: input.snapshotCount,
      totalRowCount: input.totalRowCount,
      errorSummary,
      errorDetails: input.errorDetails,
    },
  });
}

export async function getLatestFinanceSyncRun(workflow?: string) {
  const normalizedWorkflow = workflow ? normalizeRequiredText(workflow, "workflow") : undefined;

  return prisma.financeSyncRun.findFirst({
    where: normalizedWorkflow ? { workflow: normalizedWorkflow } : undefined,
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
  });
}

export async function upsertFinanceSnapshot(input: UpsertFinanceSnapshotInput) {
  assertNonNegativeCount(input.rowCount, "rowCount");
  const scope =
    normalizeOptionalText(input.scope) ?? DEFAULT_FINANCE_SNAPSHOT_SCOPE;

  return prisma.financeSnapshot.upsert({
    where: {
      snapshotType_scope_asOfDate: {
        snapshotType: input.snapshotType,
        scope,
        asOfDate: input.asOfDate,
      },
    },
    create: {
      snapshotType: input.snapshotType,
      scope,
      asOfDate: input.asOfDate,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      rowCount: input.rowCount,
      currency: normalizeOptionalText(input.currency),
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      payload: input.payload,
      syncRunId: input.syncRunId ?? null,
    },
    update: {
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      rowCount: input.rowCount,
      currency: normalizeOptionalText(input.currency),
      sourceUpdatedAt: input.sourceUpdatedAt ?? null,
      payload: input.payload,
      syncRunId: input.syncRunId ?? null,
    },
  });
}

export async function listFinanceSnapshotHeaders(input?: {
  snapshotType?: FinanceSnapshotType;
  scope?: string;
  limit?: number;
}) {
  const take = Math.min(Math.max(input?.limit ?? 20, 1), 100);
  const normalizedScope = normalizeOptionalText(input?.scope);

  return prisma.financeSnapshot.findMany({
    where: {
      ...(input?.snapshotType ? { snapshotType: input.snapshotType } : {}),
      ...(normalizedScope ? { scope: normalizedScope } : {}),
    },
    select: {
      id: true,
      snapshotType: true,
      scope: true,
      asOfDate: true,
      periodStart: true,
      periodEnd: true,
      rowCount: true,
      currency: true,
      sourceUpdatedAt: true,
      syncRunId: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ asOfDate: "desc" }, { updatedAt: "desc" }],
    take,
  });
}
