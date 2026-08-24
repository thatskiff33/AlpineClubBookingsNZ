/**
 * Per-wizard cursor/progress store for the reusable guided-provider setup shell
 * (#2080).
 *
 * The reusable wizard shell (src/components/admin/integration-wizard/) resumes a
 * reload mid-flow at the right step by persisting a small cursor here — ONE row
 * per wizard id ("xero" here; "stripe"/"google" later). This is deliberately NOT
 * the setup-readiness progress store (SETUP_STEP_IDS in setup-readiness.ts):
 * that tracks the fixed first-install checklist steps with complete/skip flags and
 * has no per-wizard cursor. (It used to say "15 steps"; the count is left out on
 * purpose now — it was already wrong by two when #3034 added an eighteenth, and a
 * number in a comment nobody updates is worse than no number.)
 *
 * IMPORTANT: the persisted `completedStepIds` are ADVISORY (an acknowledgement /
 * resume record). Whether a step is actually verified is always RE-DERIVED from
 * live server truth (credentials set, Xero connected) by the wizard config on
 * load — never trusted from this row. So a stale cursor can never make an
 * unverified step look verified; at worst it resumes on a step the operator has
 * since satisfied, and the shell simply lets them continue.
 */

import { prisma } from "@/lib/prisma";

export interface IntegrationWizardProgress {
  wizardId: string;
  currentStepId: string;
  completedStepIds: string[];
  updatedAt: string | null;
}

/** Read a wizard's persisted cursor, or null when none has been saved yet. */
export async function getIntegrationWizardProgress(
  wizardId: string,
): Promise<IntegrationWizardProgress | null> {
  const row = await prisma.integrationWizardProgress.findUnique({
    where: { wizardId },
  });
  if (!row) return null;
  return {
    wizardId: row.wizardId,
    currentStepId: row.currentStepId,
    completedStepIds: row.completedStepIds,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Persist a wizard's cursor (upsert on wizardId). `completedStepIds` is
 * de-duplicated and stored as-given — the caller owns the semantics.
 */
export async function saveIntegrationWizardProgress(params: {
  wizardId: string;
  currentStepId: string;
  completedStepIds: string[];
  updatedByMemberId?: string | null;
}): Promise<IntegrationWizardProgress> {
  const completedStepIds = Array.from(new Set(params.completedStepIds));
  const row = await prisma.integrationWizardProgress.upsert({
    where: { wizardId: params.wizardId },
    create: {
      wizardId: params.wizardId,
      currentStepId: params.currentStepId,
      completedStepIds,
      updatedByMemberId: params.updatedByMemberId ?? null,
    },
    update: {
      currentStepId: params.currentStepId,
      completedStepIds,
      updatedByMemberId: params.updatedByMemberId ?? null,
    },
  });
  return {
    wizardId: row.wizardId,
    currentStepId: row.currentStepId,
    completedStepIds: row.completedStepIds,
    updatedAt: row.updatedAt.toISOString(),
  };
}
